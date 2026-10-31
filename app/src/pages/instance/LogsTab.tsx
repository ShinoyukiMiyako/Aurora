// 日志与历史：左侧日志控制台（本实例有会话就看会话日志，否则看最近一次启动的留底），右侧 Mod 变更时间线。
// 时间线上可回滚的给回滚按钮，不可回滚的如实写原因；回滚不确认，它本身会再记一条可追溯的回滚记录。

import { useMemo, useState } from "react";
import { Icon } from "../../art/Icon";
import { ACTION_ERROR, phaseLabel } from "../../copy/flows";
import { logLineFromDto, type InstanceSummary } from "../../domain/adapt";
import { clock, formatDate, formatRelative } from "../../domain/format";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import type { LogLine } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useHistory, useLastLaunchLog, useRollbackChecks } from "../../state/queries/instance";
import { isSessionActive, type SessionState } from "../../state/session";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { countLogLevels, LOG_LEVEL_FILTER_LABEL, LOG_SOURCE_FILTER_LABEL, LogConsole, type LogLevelFilter, type LogSourceFilter } from "../../ui/LogConsole";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Tooltip } from "../../ui/Tooltip";
import { HISTORY_KIND_LABEL, LOGS_COPY } from "./copy";
import styles from "./instance.module.css";
import { HISTORY_PAGE, historyItems, type HistoryItem } from "./model";
import { lockReason, type InstanceOps } from "./ops";
import { ModuleError, SlowHint, useModuleView } from "./parts";

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
  const lastLog = useLastLaunchLog(session === null ? queryId : null);
  // 留底最多 5000 行，而这张卡随会话日志重渲染（游戏日志每 100 ms 一批）：转换结果按查询结果缓存，
  // 行对象不变，控制台按行对象分配的键与测量缓存才不会每次整批作废
  const lastData = lastLog.status === "ready" ? lastLog.data : null;
  const lastLines = useMemo(() => (lastData === null ? NO_LINES : lastData.lines.map(logLineFromDto)), [lastData]);
  const lines = session !== null ? session.logs : lastLines;
  const counts = useMemo(() => countLogLevels(lines, source), [lines, source]);
  const load = useModuleView(lastLog);

  let dropped = 0;
  let subtitle: string;
  const live = session !== null && isSessionActive(session);
  if (session !== null) {
    subtitle = live ? LOGS_COPY.live(phaseLabel(session.phase, session.stopReason)) : LOGS_COPY.sessionEnded;
  } else if (load.view === "pending" || load.view === "skeleton") {
    return (
      <Card className={styles.console}>
        <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} />
        {load.view === "skeleton" && <Skeleton shape="text" lines={SKELETON_LINES} />}
        <SlowHint slow={load.slow} />
      </Card>
    );
  } else if (lastLog.status === "error") {
    return (
      <Card className={styles.console}>
        <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} />
        <ModuleError title={LOGS_COPY.error} error={lastLog.error} onRetry={lastLog.reload} />
      </Card>
    );
  } else if (lastData !== null) {
    dropped = lastData.omitted;
    const ended = lastData.ended;
    subtitle = LOGS_COPY.lastLaunch(formatRelative(lastData.started_at, now), ended !== null && ended.outcome === "crashed");
  } else {
    return (
      <Card className={styles.console}>
        <CardHeader icon="terminal" title={LOGS_COPY.consoleTitle} subtitle={LOGS_COPY.noRecord} />
        <EmptyState compact scene="book-pen" title={LOGS_COPY.emptyTitle} body={LOGS_COPY.emptyBody} />
      </Card>
    );
  }

  return (
    <Card padding="none" className={styles.console}>
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
            <SegmentedControl
              size="sm"
              value={level}
              onChange={setLevel}
              ariaLabel={LOGS_COPY.levelFilter}
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
    </Card>
  );
}

// ---------------------------------------------------------------- 变更历史

const KIND_ICON = { install: "download", update: "refresh", remove: "trash", rollback: "rollback" } as const;
const KIND_TONE = { install: "ok", update: "info", remove: "danger", rollback: "accent" } as const;
const FILE_CHIPS = 2;

function HistoryCard({ queryId, ops }: { queryId: string | null; ops: InstanceOps }) {
  const history = useHistory(queryId);
  const checks = useRollbackChecks(queryId);
  const [limit, setLimit] = useState(HISTORY_PAGE);

  const ready = history.status === "ready" && checks.status === "ready";
  const error = history.status === "error" ? history : checks.status === "error" ? checks : null;
  const gate = useLoadingGate(!ready && error === null);
  const items = ready && gate.view === "content" ? historyItems(history.data, checks.data, LOGS_COPY) : null;
  const rollbackable = items === null ? 0 : items.filter((i) => i.canRollback).length;
  const subtitle = items === null ? undefined : items.length > 0 ? LOGS_COPY.historySubtitle(items.length, rollbackable) : LOGS_COPY.historyEmptySubtitle;

  return (
    <Card className={styles.historyCard}>
      <CardHeader icon="history" title={LOGS_COPY.historyTitle} subtitle={subtitle} />
      {gate.view === "content" && error !== null && error.status === "error" && <ModuleError title={LOGS_COPY.historyError} error={error.error} onRetry={error.reload} />}
      {gate.view === "skeleton" && <Skeleton shape="text" lines={4} />}
      <SlowHint slow={gate.slow} />
      {items !== null && items.length === 0 && <EmptyState compact scene="clock" title={LOGS_COPY.historyEmptyTitle} body={LOGS_COPY.historyEmptyBody} />}
      {items !== null && items.length > 0 && (
        <div className={styles.timelineScroll}>
          <ol className={styles.timeline}>
            {items.slice(0, limit).map((item) => (
              <TimelineItem key={item.event.id} item={item} queryId={queryId} ops={ops} />
            ))}
          </ol>
          {items.length > limit && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + HISTORY_PAGE)}>
              {LOGS_COPY.showEarlier(Math.min(HISTORY_PAGE, items.length - limit))}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function TimelineItem({ item, queryId, ops }: { item: HistoryItem; queryId: string | null; ops: InstanceOps }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const kind = item.event.kind;
  const files = item.files.slice(0, FILE_CHIPS);
  const lock = lockReason(ops.locks.mods, "mods");

  const rollback = () => {
    if (queryId === null) return;
    setBusy(true);
    void run(() => actions.rollback(queryId, item.event.id), ACTION_ERROR.rollback).then(() => setBusy(false));
  };

  return (
    <li className={styles.tlItem}>
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
    </li>
  );
}
