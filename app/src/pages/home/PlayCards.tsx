// 游玩日历（当月热力 + 选中那天玩了哪些实例）与游玩洞察（近 7 天、连续天数、常玩加载器、累计时长、近 7 天柱）。
// 两张卡共享页面里的「选中日期」：点洞察里的柱子，日历选中那一天并翻到它所在的月份。
//
// 加载态与内容同尺寸：骨架照真实内容逐行画（行高取同一处样式），数据到达时只交叉淡化、不撑高卡片。
// 近 7 天柱与日历一样，加载期间就画出柱槽与星期（日期由今天算得出），数据到了数值淡入、填充长出来。
// 常玩加载器、累计时长与当天玩过的实例还要等实例列表：游玩记录先到时只有这几块留在骨架里，列表读完再各自淡入。

import { motion } from "framer-motion";
import { useState } from "react";
import { BOOT_SLICE_ERROR, LOADER_NAME } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatCount, formatPlaytime } from "../../domain/format";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import type { LoadingView } from "../../lib/loading-gate";
import { fade } from "../../lib/motion";
import { cssVars } from "../../lib/util";
import { useNav } from "../../shell/shell";
import { describeError } from "../../state/errors";
import { useLauncherSelector } from "../../state/launcher";
import type { PlayDayDto } from "../../state/queries/home";
import { findInstance } from "../../state/selectors";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { CalendarHeatmap, addMonths, calendarDayLabel, weekdayIndex } from "../../ui/CalendarHeatmap";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { Inset } from "../../ui/Inset";
import { List, ListRow } from "../../ui/ListRow";
import { Loadable } from "../../ui/Loadable";
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
  type LoaderShare,
  type PlayActivity,
} from "./activity";
import { HOME_COPY, WEEKDAY_CHAR } from "./copy";
import { SKELETON_SIZE } from "./layout";
import type { PlayView } from "./play-view";
import s from "./home.module.css";

/** 连续游玩满这么多天写「一周没断过」。 */
const STREAK_WEEK = 7;
const EMPTY_CALENDAR: ReadonlyMap<string, number> = new Map();
/** 当日实例行的头像边长，骨架照同一个数画。 */
const DAY_AVATAR = 24;
/** 当日实例的列表骨架至多画几行：Skeleton 约定的列表上限，早已超出列表的最大高度，再多也看不见。 */
const DAY_SKELETON_ROWS = 6;

/**
 * 要按实例列表算的几块（常玩加载器、累计时长、当天玩过的实例）怎么画。游玩记录通常比实例列表（要扫盘）先到，
 * 按还空着的列表算会写出「暂无」「0 个实例」「已被删除」，所以列表读完之前这几块照它的加载门画骨架。
 */
export interface InstancesView {
  view: LoadingView;
  /** 实例列表读取出错：这几块写读不到，错误本身由继续游玩大卡原位报。 */
  failed: boolean;
}

/**
 * 实例列表由卡片这一层订阅、按 props 往下传，下面的块不自己订阅。重扫因数据格式被拒时，store 在同一次更新里清空列表并把
 * 切片置为出错：退场中的旧层（读到列表时的那一面）若自己订阅，淡出的那一段会按空列表重算出「暂无」「0 个实例」「已被删除」；
 * 按 props 拿的话，旧层留着的是出错前最后一次的值。
 */
type InstanceList = InstanceSummary[];

function dayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return HOME_COPY.dayLabel(m, d, weekdayIndex(date));
}

function monthParts(month: string): { year: number; month: number } {
  const [year, m] = month.split("-").map(Number);
  return { year, month: m };
}

/** 交给 Loadable 的加载视图：加载中照加载门；就绪是内容。出错时卡片整面换成错误态，不经过这里。 */
function loadView(play: Exclude<PlayView, { status: "error" }>): LoadingView {
  return play.status === "loading" ? play.gate.view : "content";
}

/** 加载门在内容视图下给出的游玩记录。门与数据由同一个查询驱动，内容视图时必然已就绪。 */
function readyActivity(play: Exclude<PlayView, { status: "error" }>): PlayActivity {
  if (play.status !== "ready") throw new Error("游玩记录还在加载，却要画内容");
  return play.activity;
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
  /** 当日详情里列出当天玩过的实例要等它。 */
  instances: InstancesView;
  /** 今天，YYYY-MM-DD。 */
  today: string;
  month: string;
  onMonthChange: (month: string) => void;
  selected: string;
  onSelect: (date: string) => void;
}

export function CalendarCard({ span, play, instances, today, month, onMonthChange, selected, onSelect }: CalendarCardProps) {
  const list = useLauncherSelector((s) => s.instances);
  const ready = play.status === "ready" ? play.activity : null;
  const minMonth = ready === null ? month : ready.minMonth;
  const maxMonth = ready === null ? month : ready.maxMonth;
  // 跨过午夜或记录范围收窄时，停留的月份可能落到范围外：按范围夹住，不让日历抛错
  const shown = month < minMonth ? minMonth : month > maxMonth ? maxMonth : month;
  const { year, month: m } = monthParts(shown);

  // 加载中传 null：卡头先占住副标题这一行，文案到了原位淡入；出错时这一行不要
  let subtitle: string | null | undefined;
  if (ready !== null) {
    const summary = monthSummary(ready, shown);
    subtitle = HOME_COPY.calendarSubtitle(year, m, summary.playedDays, summary.minutes);
  } else if (play.status === "loading") {
    subtitle = null;
  }

  return (
    <Card span={span}>
      <CardHeader
        level={2}
        title={HOME_COPY.calendarTitle}
        subtitle={subtitle}
        icon="calendar"
        actions={
          <>
            <IconButton icon="chevron-left" size="sm" label={HOME_COPY.prevMonth} disabled={ready === null || shown <= minMonth} onClick={() => onMonthChange(addMonths(shown, -1))} />
            <IconButton icon="chevron-right" size="sm" label={HOME_COPY.nextMonth} disabled={ready === null || shown >= maxMonth} onClick={() => onMonthChange(addMonths(shown, 1))} />
          </>
        }
      />
      {/* 出错与正文互换时交叉淡化（读取失败、点重试） */}
      <Appear>
        {play.status === "error" ? (
          <StatsError key="error" play={play} />
        ) : (
          <div key="body" className={s.calendarBody}>
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
              <Loadable view={loadView(play)} skeleton={<DaySkeleton />}>
                {() => <DayDetail activity={readyActivity(play)} date={selected} instances={instances} list={list} />}
              </Loadable>
            </Inset>
          </div>
        )}
      </Appear>
    </Card>
  );
}

/** 当日详情的骨架：时长一行加说明一行，行高与真实的两行相同（「这天没有游玩」与「已被删除」正是这个形状）。 */
function DaySkeleton() {
  return (
    <span className={s.dayBody}>
      <span className={s.dayTime}>
        <Skeleton shape="text" width="40%" />
      </span>
      <span className={s.dayHint}>
        <Skeleton shape="text" width="70%" />
      </span>
    </span>
  );
}

interface DayDetailProps {
  activity: PlayActivity;
  date: string;
  instances: InstancesView;
  list: InstanceList;
}

function DayDetail({ activity, date, instances, list }: DayDetailProps) {
  // 改选日期时新的一天淡入，读得出换了一天；挂载时就在的那天跟着骨架换内容的淡入走，不再叠一层
  const [firstDate] = useState(date);
  const [moved, setMoved] = useState(false);
  if (!moved && date !== firstDate) setMoved(true);
  return (
    <motion.div key={date} className={s.dayBody} initial={moved ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
      <DayContent activity={activity} date={date} instances={instances} list={list} />
    </motion.div>
  );
}

function DayContent({ activity, date, instances, list }: DayDetailProps) {
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
  // 当天的时长来自游玩记录，照常先出；玩过哪些实例要拿列表对照，列表读完之前由同形的列表骨架占着。
  // 说明与列表放在 dayBody 那一层里（Appear 的包裹层），上边距与直接排在正文里时一样起作用
  return (
    <>
      <span className={s.dayTime}>{formatPlaytime(day.minutes)}</span>
      <Loadable view={instances.view} skeleton={<DayInstancesSkeleton count={day.instances.length} />}>
        {() => (
          // 读取出错与读到列表互换时交叉淡化（出错后重扫读到了，或重扫时目录变得打不开）
          <Appear itemClassName={s.dayBody}>
            {instances.failed ? (
              <span key="failed" className={s.dayHint}>
                {BOOT_SLICE_ERROR.instances}
              </span>
            ) : (
              <DayInstances key="listed" alive={aliveOn(day.instances, list)} />
            )}
          </Appear>
        )}
      </Loadable>
    </>
  );
}

/** 当天玩过的实例还在等实例列表：照列表逐行画，行数取当天的记录条数（其中已删除的读到后不列，多半一个也没有）。 */
function DayInstancesSkeleton({ count }: { count: number }) {
  return (
    <span className={s.dayBody}>
      <List className={s.dayList}>
        {Array.from({ length: Math.min(count, DAY_SKELETON_ROWS) }, (_, i) => (
          <ListRow key={i} size="sm" leading={<Skeleton shape="square" size={DAY_AVATAR} />} title={<Skeleton shape="text" width="60%" />} />
        ))}
      </List>
    </span>
  );
}

/** 当天玩过、现在还在列表里的实例。 */
function aliveOn(entries: PlayDayDto["instances"], instances: InstanceList): InstanceSummary[] {
  return entries.flatMap((entry) => {
    const inst = findInstance({ instances }, entry.version_id);
    return inst === undefined ? [] : [inst];
  });
}

function DayInstances({ alive }: { alive: readonly InstanceSummary[] }) {
  const { go } = useNav();
  if (alive.length === 0) return <span className={s.dayHint}>{HOME_COPY.dayDeleted}</span>;
  return (
    <List className={s.dayList}>
      {alive.map((inst) => (
        <ListRow
          key={inst.id}
          size="sm"
          leading={<InstanceAvatar instance={inst} size={DAY_AVATAR} status={false} />}
          title={inst.name}
          ariaLabel={HOME_COPY.openInstance(inst.name)}
          onClick={() => go({ page: "instance", id: inst.id, tab: "overview" })}
        />
      ))}
    </List>
  );
}

// ---------------------------------------------------------------- 游玩洞察

export interface InsightsCardProps {
  span: ResponsiveValue;
  play: PlayView;
  /** 常玩加载器与累计时长要等它。 */
  instances: InstancesView;
  today: string;
  selected: string;
  onPickDay: (date: string) => void;
  className?: string;
}

export function InsightsCard({ span, play, instances, today, selected, onPickDay, className }: InsightsCardProps) {
  const list = useLauncherSelector((s) => s.instances);
  return (
    <Card span={span} className={className}>
      <CardHeader level={2} title={HOME_COPY.insightsTitle} subtitle={HOME_COPY.insightsSubtitle} icon="activity" />
      {/* 出错与正文互换时交叉淡化；包裹层撑满卡片，卡片被同排拉高时近 7 天柱照常压在底边 */}
      <Appear itemClassName={s.insightsFace}>
        {play.status === "error" ? (
          <StatsError key="error" play={play} />
        ) : (
          <InsightsBody key="body" play={play} instances={instances} list={list} today={today} selected={selected} onPickDay={onPickDay} />
        )}
      </Appear>
    </Card>
  );
}

interface InsightsBodyProps {
  play: Exclude<PlayView, { status: "error" }>;
  instances: InstancesView;
  list: InstanceList;
  today: string;
  selected: string;
  onPickDay: (date: string) => void;
}

function InsightsBody({ play, instances, list, today, selected, onPickDay }: InsightsBodyProps) {
  return (
    <div className={s.insightsBody}>
      <Loadable view={loadView(play)} skeleton={<StatSkeletons />}>
        {() => <InsightStats activity={readyActivity(play)} instances={instances} list={list} />}
      </Loadable>
      <WeekBars activity={play.status === "ready" ? play.activity : null} today={today} selected={selected} onPickDay={onPickDay} />
    </div>
  );
}

/** 数据块骨架：照 StatTile 画标签、数值、环比三行，行高逐行相同。真实数据块的环比偶尔缺席，矮出的那点由让位接住。 */
function StatSkeleton() {
  return (
    <span className={s.statSkeleton}>
      <Skeleton shape="text" width="50%" />
      <span className={s.statSkeletonValue}>
        <Skeleton shape="block" width="70%" height={SKELETON_SIZE.statValue} radius="sm" />
      </span>
      <Skeleton shape="text" width="60%" />
    </span>
  );
}

function StatSkeletons() {
  return (
    <StatGrid columns={2}>
      {Array.from({ length: 4 }, (_, i) => (
        <StatSkeleton key={i} />
      ))}
    </StatGrid>
  );
}

function InsightStats({ activity, instances, list }: { activity: PlayActivity; instances: InstancesView; list: InstanceList }) {
  const week = weekCompare(activity);
  const streak = streakDays(activity);

  return (
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
        delta={streak === 0 ? undefined : { direction: "flat", text: streak >= STREAK_WEEK ? HOME_COPY.streakWeek : HOME_COPY.streakKeep }}
      />
      {/* 后两块要按实例列表算：列表读完之前各自占着一块骨架，读完淡入；读取出错与读到列表互换时交叉淡化 */}
      <Loadable view={instances.view} skeleton={<StatSkeleton />}>
        {() => (
          <Appear>
            {instances.failed ? <StatTile key="failed" label={HOME_COPY.topLoader} kind="text" value={HOME_COPY.topLoaderUnknown} /> : <TopLoaderTile key="listed" top={topLoader(activity, list)} />}
          </Appear>
        )}
      </Loadable>
      <Loadable view={instances.view} skeleton={<StatSkeleton />}>
        {() => (
          <Appear>
            {instances.failed ? (
              <StatTile key="failed" label={HOME_COPY.total} kind="text" value={HOME_COPY.totalUnknown} delta={{ direction: "flat", text: BOOT_SLICE_ERROR.instances }} />
            ) : (
              <TotalTile key="listed" total={totalPlaytime(list)} />
            )}
          </Appear>
        )}
      </Loadable>
    </StatGrid>
  );
}

function TopLoaderTile({ top }: { top: LoaderShare | null }) {
  return (
    <StatTile
      label={HOME_COPY.topLoader}
      kind="text"
      value={top === null ? HOME_COPY.none : LOADER_NAME[top.loader]}
      delta={top === null ? undefined : { direction: "flat", text: HOME_COPY.topLoaderShare(Math.round(top.share * 100)) }}
    />
  );
}

function TotalTile({ total }: { total: ReturnType<typeof totalPlaytime> }) {
  if (total.hours === null) {
    return <StatTile label={HOME_COPY.total} kind="text" value={HOME_COPY.totalUnknown} delta={{ direction: "flat", text: HOME_COPY.instanceCount(total.count) }} />;
  }
  return <StatTile label={HOME_COPY.total} value={formatCount(total.hours)} unit={HOME_COPY.hours} delta={{ direction: "flat", text: HOME_COPY.instanceCount(total.count) }} />;
}

interface WeekBarsProps {
  /** 游玩记录；还在加载时为 null：柱槽与星期照画，数值留空、填充为 0，柱子不可点。 */
  activity: PlayActivity | null;
  today: string;
  selected: string;
  onPickDay: (date: string) => void;
}

/**
 * 近 7 天柱。加载前后是同一组元素：日期由今天就能算出，星期标签加载期间就是真的；数据到了，数值淡入（样式里按 data-empty 过渡），
 * 填充沿 settle 从 0 长到各自的高度。挂载时数据就在的不播：样式过渡只在值变化时发生。
 */
function WeekBars({ activity, today, selected, onPickDay }: WeekBarsProps) {
  const days = lastDays(today, WEEK_DAYS);
  const max = activity === null ? 0 : Math.max(...days.map((d) => minutesOn(activity, d)));
  return (
    <div className={s.bars} role="group" aria-label={HOME_COPY.barsLabel} aria-busy={activity === null || undefined}>
      {days.map((date) => {
        const minutes = activity === null ? null : minutesOn(activity, date);
        const isToday = date === today;
        const recorded = activity !== null && activity.calendar.has(date);
        return (
          <button
            key={date}
            type="button"
            className={s.bar}
            disabled={activity === null}
            // 加载期间这几根是占位：时长还没到，按「无记录」给标签会把每一天都读成没玩。禁用的按钮不可聚焦，
            // 整根从读屏里藏起来不会藏住焦点；读屏只读到组的名称与 aria-busy，和骨架一样
            aria-hidden={activity === null || undefined}
            data-today={isToday || undefined}
            data-picked={date === selected || undefined}
            aria-pressed={date === selected}
            aria-label={minutes === null ? undefined : calendarDayLabel(date, recorded ? minutes : undefined, isToday)}
            onClick={() => onPickDay(date)}
          >
            <span className={s.barValue} data-empty={minutes === null || undefined}>
              {minutes === null ? null : barValue(minutes)}
            </span>
            <span className={s.barTrack}>
              <span className={s.barFill} style={cssVars({ "--fill": minutes === null ? 0 : barFill(minutes, max) })} />
            </span>
            <span className={s.barLabel}>{isToday ? HOME_COPY.barToday : WEEKDAY_CHAR[weekdayIndex(date)]}</span>
          </button>
        );
      })}
    </div>
  );
}
