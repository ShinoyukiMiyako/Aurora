// 游玩日历（当月热力 + 选中那天玩了哪些实例）与游玩洞察（近 7 天、连续天数、常玩加载器、累计时长、近 7 天柱）。
// 两张卡共享页面里的「选中日期」：点洞察里的柱子，日历选中那一天并翻到它所在的月份。

import { LOADER_NAME } from "../../copy/flows";
import { formatCount, formatPlaytime } from "../../domain/format";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import { cssVars, cx } from "../../lib/util";
import { useNav } from "../../shell/shell";
import { describeError } from "../../state/errors";
import { useLauncherSelector } from "../../state/launcher";
import { findInstance } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { CalendarHeatmap, addMonths, calendarDayLabel, weekdayIndex } from "../../ui/CalendarHeatmap";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { Inset } from "../../ui/Inset";
import { List, ListRow } from "../../ui/ListRow";
import { Skeleton } from "../../ui/Skeleton";
import { StatGrid, StatTile } from "../../ui/StatTile";
import {
  WEEK_DAYS,
  barFill,
  barValue,
  lastDays,
  minutesOn,
  monthSummary,
  ratioPercent,
  streakDays,
  topLoader,
  totalPlaytime,
  weekCompare,
  weekDirection,
  type PlayActivity,
} from "./activity";
import { HOME_COPY, WEEKDAY_CHAR } from "./copy";
import { SKELETON_SIZE } from "./layout";
import type { PlayView } from "./play-view";
import s from "./home.module.css";

/** 连续游玩满这么多天写「一周没断过」。 */
const STREAK_WEEK = 7;
const EMPTY_CALENDAR: ReadonlyMap<string, number> = new Map();

function dayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return HOME_COPY.dayLabel(m, d, weekdayIndex(date));
}

function monthParts(month: string): { year: number; month: number } {
  const [year, m] = month.split("-").map(Number);
  return { year, month: m };
}

function StatsError({ play }: { play: Extract<PlayView, { status: "error" }> }) {
  return (
    <EmptyState
      scene="error"
      compact
      title={HOME_COPY.statsError}
      body={describeError(play.error)}
      action={
        <Button variant="secondary" icon="refresh" onClick={play.retry}>
          {HOME_COPY.retry}
        </Button>
      }
    />
  );
}

// ---------------------------------------------------------------- 游玩日历

export interface CalendarCardProps {
  span: ResponsiveValue;
  play: PlayView;
  /** 今天，YYYY-MM-DD。 */
  today: string;
  month: string;
  onMonthChange: (month: string) => void;
  selected: string;
  onSelect: (date: string) => void;
}

export function CalendarCard({ span, play, today, month, onMonthChange, selected, onSelect }: CalendarCardProps) {
  const ready = play.status === "ready" ? play.activity : null;
  const minMonth = ready === null ? month : ready.minMonth;
  const maxMonth = ready === null ? month : ready.maxMonth;
  // 跨过午夜或记录范围收窄时，停留的月份可能落到范围外：按范围夹住，不让日历抛错
  const shown = month < minMonth ? minMonth : month > maxMonth ? maxMonth : month;
  const { year, month: m } = monthParts(shown);
  const pending = play.status === "loading" && play.gate.view === "pending";

  let subtitle: string | undefined;
  if (ready !== null) {
    const summary = monthSummary(ready, shown);
    subtitle = HOME_COPY.calendarSubtitle(year, m, summary.playedDays, summary.minutes);
  }

  return (
    <Card span={span}>
      <CardHeader
        level={2}
        title={HOME_COPY.calendarTitle}
        subtitle={play.status === "loading" ? <Skeleton shape="text" width="60%" className={cx(pending && s.pending)} /> : subtitle}
        icon="calendar"
        actions={
          <>
            <IconButton icon="chevron-left" size="sm" label={HOME_COPY.prevMonth} disabled={ready === null || shown <= minMonth} onClick={() => onMonthChange(addMonths(shown, -1))} />
            <IconButton icon="chevron-right" size="sm" label={HOME_COPY.nextMonth} disabled={ready === null || shown >= maxMonth} onClick={() => onMonthChange(addMonths(shown, 1))} />
          </>
        }
      />
      {play.status === "error" ? (
        <StatsError play={play} />
      ) : (
        <div className={s.calendarBody}>
          <CalendarHeatmap
            month={shown}
            minutes={ready === null ? EMPTY_CALENDAR : ready.calendar}
            today={today}
            selected={selected}
            onSelect={onSelect}
            onMonthChange={onMonthChange}
            minMonth={minMonth}
            maxMonth={maxMonth}
          />
          <Inset className={s.dayDetail}>
            <span className={s.dayDate}>{dayLabel(selected)}</span>
            {ready === null ? (
              <span className={cx(s.daySkeleton, pending && s.pending)} aria-busy="true">
                <Skeleton shape="text" lines={2} />
              </span>
            ) : (
              <DayDetail activity={ready} date={selected} />
            )}
          </Inset>
        </div>
      )}
    </Card>
  );
}

function DayDetail({ activity, date }: { activity: PlayActivity; date: string }) {
  const instances = useLauncherSelector((s) => s.instances);
  const { go } = useNav();
  if (!activity.hasRecords) return <span className={s.dayTime}>{HOME_COPY.noRecords}</span>;
  const day = activity.days.get(date);
  if (day === undefined) {
    return (
      <>
        <span className={s.dayTime}>{HOME_COPY.dayNoPlay}</span>
        <span className={s.dayHint}>{HOME_COPY.dayRest}</span>
      </>
    );
  }
  const alive = day.instances.flatMap((entry) => {
    const inst = findInstance({ instances }, entry.version_id);
    return inst === undefined ? [] : [inst];
  });
  return (
    <>
      <span className={s.dayTime}>{formatPlaytime(day.minutes)}</span>
      {alive.length === 0 ? (
        <span className={s.dayHint}>{HOME_COPY.dayDeleted}</span>
      ) : (
        <List className={s.dayList}>
          {alive.map((inst) => (
            <ListRow
              key={inst.id}
              size="sm"
              leading={<InstanceAvatar instance={inst} size={24} status={false} />}
              title={inst.name}
              ariaLabel={HOME_COPY.openInstance(inst.name)}
              onClick={() => go({ page: "instance", id: inst.id, tab: "overview" })}
            />
          ))}
        </List>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 游玩洞察

export interface InsightsCardProps {
  span: ResponsiveValue;
  play: PlayView;
  today: string;
  selected: string;
  onPickDay: (date: string) => void;
  className?: string;
}

export function InsightsCard({ span, play, today, selected, onPickDay, className }: InsightsCardProps) {
  return (
    <Card span={span} className={className}>
      <CardHeader level={2} title={HOME_COPY.insightsTitle} subtitle={HOME_COPY.insightsSubtitle} icon="activity" />
      {play.status === "error" ? (
        <StatsError play={play} />
      ) : play.status === "loading" ? (
        <InsightsSkeleton pending={play.gate.view === "pending"} today={today} />
      ) : (
        <InsightsBody activity={play.activity} selected={selected} onPickDay={onPickDay} />
      )}
    </Card>
  );
}

function InsightsSkeleton({ pending, today }: { pending: boolean; today: string }) {
  return (
    <div className={cx(s.insightsBody, pending && s.pending)} aria-busy="true">
      <StatGrid columns={2}>
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className={s.statSkeleton}>
            <Skeleton shape="text" width="50%" />
            <Skeleton shape="block" width="70%" height={SKELETON_SIZE.statValue} radius="sm" />
          </span>
        ))}
      </StatGrid>
      <div className={s.bars}>
        {lastDays(today, WEEK_DAYS).map((date) => (
          <span key={date} className={s.bar}>
            <span className={s.barTrack} />
          </span>
        ))}
      </div>
    </div>
  );
}

function InsightsBody({ activity, selected, onPickDay }: { activity: PlayActivity; selected: string; onPickDay: (date: string) => void }) {
  const instances = useLauncherSelector((s) => s.instances);
  const week = weekCompare(activity);
  const streak = streakDays(activity);
  const top = topLoader(activity, instances);
  const total = totalPlaytime(instances);
  const days = lastDays(activity.today, WEEK_DAYS);
  const max = Math.max(...days.map((d) => minutesOn(activity, d)));

  return (
    <div className={s.insightsBody}>
      <StatGrid columns={2}>
        <StatTile
          label={HOME_COPY.week}
          value={(week.total / 60).toFixed(1)}
          unit={HOME_COPY.hours}
          delta={{ direction: weekDirection(week.ratio), text: week.ratio === null ? HOME_COPY.weekNoPrevious : HOME_COPY.weekDelta(ratioPercent(week.ratio)) }}
        />
        <StatTile
          label={HOME_COPY.streak}
          value={String(streak)}
          unit={HOME_COPY.dayUnit}
          delta={{ direction: "flat", text: streak >= STREAK_WEEK ? HOME_COPY.streakWeek : HOME_COPY.streakKeep }}
        />
        <StatTile
          label={HOME_COPY.topLoader}
          kind="text"
          value={top === null ? HOME_COPY.none : LOADER_NAME[top.loader]}
          delta={top === null ? undefined : { direction: "flat", text: HOME_COPY.topLoaderShare(Math.round(top.share * 100)) }}
        />
        {total.hours === null ? (
          <StatTile label={HOME_COPY.total} kind="text" value={HOME_COPY.totalUnknown} delta={{ direction: "flat", text: HOME_COPY.instanceCount(total.count) }} />
        ) : (
          <StatTile
            label={HOME_COPY.total}
            value={formatCount(total.hours)}
            unit={HOME_COPY.hours}
            delta={{ direction: "flat", text: HOME_COPY.instanceCount(total.count) }}
          />
        )}
      </StatGrid>
      <div className={s.bars} role="group" aria-label={HOME_COPY.barsLabel}>
        {days.map((date) => {
          const minutes = minutesOn(activity, date);
          const isToday = date === activity.today;
          const recorded = activity.calendar.has(date);
          return (
            <button
              key={date}
              type="button"
              className={s.bar}
              data-today={isToday || undefined}
              data-picked={date === selected || undefined}
              aria-pressed={date === selected}
              aria-label={calendarDayLabel(date, recorded ? minutes : undefined, isToday)}
              onClick={() => onPickDay(date)}
            >
              <span className={s.barValue}>{barValue(minutes)}</span>
              <span className={s.barTrack}>
                <span className={s.barFill} style={cssVars({ "--fill": barFill(minutes, max) })} />
              </span>
              <span className={s.barLabel}>{isToday ? HOME_COPY.barToday : WEEKDAY_CHAR[weekdayIndex(date)]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
