// 日志与历史：左侧日志控制台（本实例有会话就看会话日志，否则看最近一次启动的留底），右侧 Mod 变更时间线。
// 时间线上可回滚的给回滚按钮，不可回滚的如实写原因；回滚不确认，它本身会再记一条可追溯的回滚记录。

import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { ACTION_ERROR, phaseLabel } from "../../copy/flows";
import { logLineFromDto, type InstanceSummary } from "../../domain/adapt";
import { clock, formatDate, formatRelative } from "../../domain/format";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import type { LogLine } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { insertItem } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useHistory, useLastLaunchLog, useRollbackChecks, type HistoryEvent, type RollbackCheck } from "../../state/queries/instance";
import { isSessionActive, type SessionState } from "../../state/session";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { Loadable } from "../../ui/Loadable";
import { countLogLevels, LOG_LEVEL_FILTER_LABEL, LOG_SOURCE_FILTER_LABEL, LogConsole, type LogLevelFilter, type LogSourceFilter } from "../../ui/LogConsole";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Tooltip } from "../../ui/Tooltip";
import { HISTORY_KIND_LABEL, LOGS_COPY } from "./copy";
import styles from "./instance.module.css";
import { HISTORY_PAGE, historyItems, type HistoryItem } from "./model";
import type { InstanceOps } from "./ops";
import { ModuleError, SlowHint } from "./parts";

export interface LogsTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
}

export function LogsTab({ inst, queryId, ops }: LogsTabProps) {
  return (
    <div className={styles.logsGrid}>
      <ConsoleCard inst={inst} queryId={queryId} ops={ops} />
      <HistoryCard queryId={queryId} ops={ops} />
    </div>
  );
}

const SKELETON_LINES = 8;
const NO_LINES: readonly LogLine[] = [];

/** 日志控制台卡画出来一样：同一份日志、同一个阶段与结束原因（两边都没有会话也算）。 */
function sameConsoleSession(a: SessionState | null, b: SessionState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.logs === b.logs && a.phase === b.phase && a.stopReason === b.stopReason;
}

function ConsoleCard({ inst, queryId, ops }: LogsTabProps) {
  // 整页只有这张卡订阅会话日志：本实例的会话每来一批日志就换一份；别的实例的会话一律当作没有，它的日志不让这里重渲染。
  // 卡上只画日志行与阶段，启动下载的进度（同样约 100 ms 一次）不让它重渲染，拿到的会话里进度字段可能是旧的
  const session = useLauncherSelector((s) => (s.session !== null && s.session.instanceId === inst.id ? s.session : null), sameConsoleSession);
  const now = useNow(30_000);
  const { copyText } = useShell();
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const [source, setSource] = useState<LogSourceFilter>("all");
  const live = session !== null && isSessionActive(session);
  // 会话一离开实时就去读留底（后端推送退出事件之前已经写好）：停留期满会话清空时留底多半已经在手，直接换数据
  const lastLog = useLastLaunchLog(live ? null : queryId);
  // 会话清空了、留底还没读回（读得慢，或在状态岛里提前收起了会话）：接着画刚结束的这一局，两者是同一份输出。
  // 不在中间换成骨架：那会让整卡闪一次、控制台重挂，换行开关与滚动位置都丢掉
  const [ended, setEnded] = useState<SessionState | null>(null);
  if (session !== null && !live && ended !== session) setEnded(session);
  else if (session === null && ended !== null && lastLog.status !== "loading") setEnded(null);
  const shown = session !== null ? session : lastLog.status === "loading" ? ended : null;
  // 留底最多 5000 行，而这张卡随会话日志重渲染（游戏日志每 100 ms 一批）：转换结果按查询结果缓存，
  // 行对象不变，控制台按行对象分配的键与测量缓存才不会每次整批作废
  const lastData = lastLog.status === "ready" ? lastLog.data : null;
  const lastLines = useMemo(() => (lastData === null ? NO_LINES : lastData.lines.map(logLineFromDto)), [lastData]);
  const lines = shown !== null ? shown.logs : lastLines;
  const counts = useMemo(() => countLogLevels(lines, source), [lines, source]);
  // 只有既没有会话可画、留底又在读的时候才算加载
  const gate = useLoadingGate(shown === null && lastLog.status === "loading");

  const content = (): ReactNode => {
    let dropped = 0;
    let subtitle: string;
    if (shown !== null) {
      subtitle = live && session !== null ? LOGS_COPY.live(phaseLabel(session.phase, session.stopReason)) : LOGS_COPY.sessionEnded;
    } else if (lastLog.status === "loading") {
      throw new Error("加载门放行时最近一次启动的日志不可能还在读取");
    } else if (lastLog.status === "error") {
      return (
        <div className={styles.consolePad}>
          <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} />
          <ModuleError title={LOGS_COPY.error} error={lastLog.error} onRetry={lastLog.reload} />
        </div>
      );
    } else if (lastData !== null && lastData.ended === null && lastData.lines.length === 0) {
      return (
        <div className={styles.consolePad}>
          <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} subtitle={LOGS_COPY.lastLaunch(formatRelative(lastData.started_at, now), false)} />
          <EmptyState compact scene="book-pen" title={LOGS_COPY.noOutputTitle} body={LOGS_COPY.noOutputBody} />
        </div>
      );
    } else if (lastData !== null) {
      dropped = lastData.omitted;
      const outcome = lastData.ended;
      subtitle = LOGS_COPY.lastLaunch(formatRelative(lastData.started_at, now), outcome !== null && outcome.outcome === "crashed");
    } else {
      return (
        <div className={styles.consolePad}>
          <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} subtitle={LOGS_COPY.noRecord} />
          <EmptyState compact scene="book-pen" title={LOGS_COPY.emptyTitle} body={LOGS_COPY.emptyBody} />
        </div>
      );
    }
    return (
      <LogConsole
        title={LOGS_COPY.consoleTitle}
        subtitle={subtitle}
        lines={lines}
        dropped={dropped}
        live={live}
        level={level}
        source={source}
        onCopy={copyText}
        copyFeedbackMs={COPY_FEEDBACK_MS}
        // logs 打不开（安装、补全、改名、删除进行中）时按钮置灰并写明原因，而不是点了才报错
        onOpenFolder={() => ops.openFolder("logs")}
        openFolderDisabledReason={ops.folderReason("logs")}
        className={styles.consoleBody}
        filteredEmpty={LOGS_COPY.noLinesForFilter}
        filters={
          <>
            {/* 计数槽按四位定宽（会话与留底都至多 5000 行）：开局清零、计数进位时级别组不变宽，右边的来源组不被推动 */}
            <SegmentedControl
              size="sm"
              value={level}
              onChange={setLevel}
              ariaLabel={LOGS_COPY.levelFilter}
              countDigits={LEVEL_COUNT_DIGITS}
              options={[
                { value: "all", label: LOG_LEVEL_FILTER_LABEL.all, count: counts.all },
                { value: "warn", label: LOG_LEVEL_FILTER_LABEL.warn, count: counts.warn },
                { value: "error", label: LOG_LEVEL_FILTER_LABEL.error, count: counts.error },
              ]}
            />
            <SegmentedControl
              size="sm"
              value={source}
              onChange={setSource}
              ariaLabel={LOGS_COPY.sourceFilter}
              options={[
                { value: "all", label: LOG_SOURCE_FILTER_LABEL.all },
                { value: "launcher", label: LOG_SOURCE_FILTER_LABEL.launcher },
                { value: "game", label: LOG_SOURCE_FILTER_LABEL.game },
              ]}
            />
          </>
        }
      />
    );
  };

  // 卡片恒为无内边距：加载占位照控制台的框架画，换成控制台时只有日志区由骨架交叉淡化成日志，头部不变高、不换底色
  return (
    <Card padding="none" className={styles.console}>
      <Loadable view={gate.view} skeleton={<ConsoleSkeleton slow={gate.slow} />} className={styles.consoleFill} contentClassName={styles.consoleFill}>
        {content}
      </Loadable>
    </Card>
  );
}

/** 级别计数槽的定宽位数：会话日志与留底都至多 5000 行。 */
const LEVEL_COUNT_DIGITS = 4;

/** 控制台的加载占位：与控制台同一套框架（头部的图标、标题、副标题一行、两组筛选，下面是日志区的行）。 */
function ConsoleSkeleton({ slow }: { slow: boolean }) {
  return (
    <>
      <div className={styles.consoleSkeletonHead}>
        <CardHeader className={styles.consoleSkeletonHeader} icon={<Skeleton shape="square" size={30} />} title={LOGS_COPY.consoleTitle} subtitle={null} />
        <div className={styles.consoleSkeletonFilters}>
          <Skeleton shape="block" width={248} height={30} radius="sm" />
          <Skeleton shape="block" width={176} height={30} radius="sm" />
        </div>
      </div>
      <div className={styles.consoleSkeletonLines}>
        <Skeleton shape="text" lines={SKELETON_LINES} />
        <SlowHint slow={slow} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 变更历史

const KIND_ICON = { install: "download", update: "refresh", remove: "trash", rollback: "rollback" } as const;
const KIND_TONE = { install: "ok", update: "info", remove: "danger", rollback: "accent" } as const;
const FILE_CHIPS = 2;

/** 变更历史骨架画几条：一屏里常见的条数，多的位置留空。 */
const HISTORY_SKELETON_ITEMS = 3;

type HistoryPair = { events: HistoryEvent[]; checks: RollbackCheck[] };

function HistoryCard({ queryId, ops }: { queryId: string | null; ops: InstanceOps }) {
  const history = useHistory(queryId);
  const checks = useRollbackChecks(queryId);
  const [limit, setLimit] = useState(HISTORY_PAGE);

  // 回滚、装卸 Mod 之后两份查询一起失效重取、先后到达：先到的历史里新事件还对不上可回滚检查，按不可回滚画，
  // 后到的再改一次，时间线连跳两下。重取期间接着画上一份对得上的，两份都落定后一起换
  const [held, setHeld] = useState<HistoryPair | null>(null);
  const loaded = history.status === "ready" && checks.status === "ready";
  const settled = loaded && !history.refreshing && !checks.refreshing ? { events: history.data, checks: checks.data } : null;
  if (settled !== null && (held === null || held.events !== settled.events || held.checks !== settled.checks)) setHeld(settled);
  const pair = settled !== null ? settled : loaded ? held : null;

  const error = history.status === "error" ? history : checks.status === "error" ? checks : null;
  const gate = useLoadingGate(pair === null && error === null);
  const items = useMemo(() => (pair === null ? null : historyItems(pair.events, pair.checks, LOGS_COPY)), [pair?.events, pair?.checks]);
  const shownItems = gate.view === "content" ? items : null;
  const rollbackable = shownItems === null ? 0 : shownItems.filter((i) => i.canRollback).length;
  // 加载中先占住副标题那一行，头部不因文案晚到而变高；读不出时没有这一行
  const subtitle =
    shownItems !== null
      ? shownItems.length > 0
        ? LOGS_COPY.historySubtitle(shownItems.length, rollbackable)
        : LOGS_COPY.historyEmptySubtitle
      : gate.view === "content"
        ? undefined
        : null;

  return (
    <Card className={styles.historyCard}>
      <CardHeader icon="history" title={LOGS_COPY.historyTitle} subtitle={subtitle} />
      <Loadable view={gate.view} skeleton={<HistorySkeleton slow={gate.slow} />} className={styles.historyBody} contentClassName={styles.historyBody}>
        {() => {
          if (shownItems === null) {
            if (error === null || error.status !== "error") throw new Error("加载门放行时变更历史不可能还在读取");
            return <ModuleError title={LOGS_COPY.historyError} error={error.error} onRetry={error.reload} />;
          }
          if (shownItems.length === 0) return <EmptyState compact scene="clock" title={LOGS_COPY.historyEmptyTitle} body={LOGS_COPY.historyEmptyBody} />;
          return <Timeline items={shownItems} limit={limit} onMore={() => setLimit((n) => n + HISTORY_PAGE)} queryId={queryId} ops={ops} />;
        }}
      </Loadable>
    </Card>
  );
}

/** 变更历史的加载占位：与时间线同一套条目框架（节点圆点、连线、标题与元信息两行）。 */
function HistorySkeleton({ slow }: { slow: boolean }) {
  return (
    <>
      <div className={styles.timeline}>
        {Array.from({ length: HISTORY_SKELETON_ITEMS }, (_, i) => (
          <div key={i} className={styles.tlItem}>
            <Skeleton shape="block" width={28} height={28} radius="pill" />
            <div className={styles.tlBody}>
              <span className={styles.tlTitle}>
                <Skeleton shape="text" width={168} />
              </span>
              <span className={styles.tlMeta}>
                <Skeleton shape="text" width={112} />
              </span>
            </div>
          </div>
        ))}
      </div>
      <SlowHint slow={slow} />
    </>
  );
}

function Timeline({ items, limit, onMore, queryId, ops }: { items: readonly HistoryItem[]; limit: number; onMore(): void; queryId: string | null; ops: InstanceOps }) {
  // 时间线挂上之后才出现的条目（回滚、装卸 Mod 记下的新事件，「显示更早」展开的一批）淡入并从略小处落到位；
  // 挂载时就在的跟着卡片内容一起淡入，不再单独入场
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  // 新事件插到最上面、被撤销的那条掉了按钮变矮时，其余条目从原位置滑过去；滚动区里的锚定由让位自己按滚动量扣除
  const reflow = useReflow<HTMLOListElement>();
  return (
    <div className={styles.timelineScroll}>
      <ol ref={reflow} className={styles.timeline}>
        {items.slice(0, limit).map((item) => (
          <TimelineItem key={item.event.id} item={item} entering={mounted.current} queryId={queryId} ops={ops} />
        ))}
      </ol>
      {items.length > limit && (
        <Button variant="ghost" size="sm" onClick={onMore}>
          {LOGS_COPY.showEarlier(Math.min(HISTORY_PAGE, items.length - limit))}
        </Button>
      )}
    </div>
  );
}

function TimelineItem({ item, entering, queryId, ops }: { item: HistoryItem; entering: boolean; queryId: string | null; ops: InstanceOps }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const kind = item.event.kind;
  const files = item.files.slice(0, FILE_CHIPS);
  const lock = ops.modsReason;

  const rollback = () => {
    if (queryId === null) return;
    setBusy(true);
    void run(() => actions.rollback(queryId, item.event.id), ACTION_ERROR.rollback).then(() => setBusy(false));
  };

  return (
    <motion.li className={styles.tlItem} initial={entering ? insertItem.initial : false} animate={insertItem.animate}>
      <span className={styles.tlNode} data-tone={KIND_TONE[kind]} aria-hidden="true">
        <Icon name={KIND_ICON[kind]} size={14} />
      </span>
      <div className={styles.tlBody}>
        <div className={styles.tlTop}>
          <span className={styles.tlTitle} data-reverted={item.reverted || undefined}>
            {item.title}
          </span>
          {item.reverted && (
            <Tag size="sm" tone="outline">
              {LOGS_COPY.reverted}
            </Tag>
          )}
        </div>
        <span className={styles.tlMeta}>
          {HISTORY_KIND_LABEL[kind]}
          {" · "}
          <Tooltip content={`${formatDate(item.atMs)} ${clock(item.atMs)}`}>
            <time tabIndex={0} dateTime={new Date(item.atMs).toISOString()} className={styles.tlTime}>
              {formatRelative(item.atMs, now)}
            </time>
          </Tooltip>
          {item.from !== null && item.to !== null && (
            <span className={styles.tlVersion}>
              {item.from}
              <Icon name="arrow-right" size={12} />
              {item.to}
            </span>
          )}
        </span>
        {files.length > 0 && (
          <div className={styles.tlFiles}>
            {files.map((f) => (
              <code key={f} className={styles.fileChip}>
                {f}
              </code>
            ))}
            {item.files.length > files.length && <span className={styles.soft}>{LOGS_COPY.moreFiles(item.files.length - files.length)}</span>}
          </div>
        )}
        {item.canRollback ? (
          <div>
            <Button size="sm" icon="rollback" disabledReason={lock} loading={busy} onClick={rollback}>
              {item.from === null ? LOGS_COPY.rollback : LOGS_COPY.rollbackTo(item.from)}
            </Button>
          </div>
        ) : (
          item.blockedReason !== null && (
            <span className={styles.tlBlocked}>
              <Icon name="lock" size={12} />
              {item.blockedReason}
            </span>
          )
        )}
      </div>
    </motion.li>
  );
}
