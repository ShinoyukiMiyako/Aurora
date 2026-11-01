// 下载任务页：完整交代下载队列。现在下得多快、三条并行通道各在下什么、谁在排队、每个任务的结局。
// 标题栏的下载快览只管进行中的任务，这一页还负责历史（完成、失败及原因、取消）。
// 状态筛选写在路由上：多个下载失败合并成一条通知时，通知的「查看」直接带着「失败与取消」进页。
//
// 订阅分两层：页面只订阅任务表的结构（增删、换状态），分组、筛选、页头与已结束的行只在结构变化时重排；
// 下载进度每个任务约 100 ms 一次，只交给吞吐卡、通道卡与运行中的那一行，它们各自订阅自己要的那一片。

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ACTION_ERROR, BOOT_SLICE_ERROR, PAGE_LABEL, SLOW_LOADING_HINT } from "../../copy/flows";
import type { Task } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useOnline } from "../../state/online";
import type { PageProps, TaskFilter } from "../../state/route";
import type { BlockedFileDto } from "../../state/store";
import { isActiveTask, queuePosition } from "../../state/tasks";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { List } from "../../ui/ListRow";
import { EntranceBlock, Page } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { BlockedFilesModal } from "../discover/BlockedFilesModal";
import { RELATIVE_TIME_REFRESH_MS } from "./constants";
import { TASKS_COPY } from "./copy";
import { LanesCard } from "./LanesCard";
import {
  bucketTasks,
  cancelAllConfirm,
  cancelConfirm,
  etaSpeed,
  filterCounts,
  filterOf,
  filterRoute,
  overviewOf,
  rowMeta,
  sameTaskLayout,
  TASK_FILTERS,
  taskGroups,
  type TaskBuckets,
} from "./model";
import styles from "./tasks.module.css";
import { TaskRow } from "./TaskRow";
import { readThroughputHistory, ThroughputScope } from "./throughput";
import { ThroughputCard } from "./ThroughputCard";

export default function TasksPage({ route }: PageProps<"tasks">) {
  // 运行中任务的对象在这里停在上一次结构变化时：它们的进度只由下面的进度部件读
  const tasks = useLauncherSelector((s) => s.tasks, sameTaskLayout);
  const slice = useLauncherSelector((s) => s.status.tasks);
  const unseenFailures = useLauncherSelector((s) => s.unseenFailures);
  const instanceIds = useLauncherSelector((s) => s.instances.map((i) => i.id), shallowArrayEqual);
  const actions = useLauncherActions();
  const nav = useNav();
  const { confirm, openCreateInstance } = useShell();
  const run = useRunner();
  const [blocked, setBlocked] = useState<{ open: boolean; files: readonly BlockedFileDto[]; taskId: string } | null>(null);
  const online = useOnline();
  const now = useNow(RELATIVE_TIME_REFRESH_MS);
  const titleId = useId();

  const filter = filterOf(route);
  const buckets = bucketTasks(tasks);
  const counts = filterCounts(buckets);
  const active = [...buckets.running, ...buckets.queued];

  // 确认框开着的时候任务可能已经自己结束了：确认后按最新的任务表判断还有没有可取消的（状态变化属于结构，这里总是新的）
  const latestTasks = useRef(tasks);
  useLayoutEffect(() => {
    latestTasks.current = tasks;
  });
  const stillActive = (id: string) => latestTasks.current.some((t) => t.id === id && isActiveTask(t));

  // 进到这一页即算看过全部失败；停在这一页期间新出现的失败也就在列表里，同样算看过
  useEffect(() => {
    if (unseenFailures > 0) actions.markFailuresSeen();
  }, [actions, unseenFailures]);

  const gate = useLoadingGate(slice.kind === "loading" && tasks.length === 0);
  const showSkeleton = gate.view === "skeleton";

  const cancel = async (task: Task) => {
    const ask = cancelConfirm(task);
    if (ask !== null && !(await confirm(ask))) return;
    if (!stillActive(task.id)) return;
    await run(() => actions.cancelTask(task.id), ACTION_ERROR.cancelTask);
  };

  const cancelAll = async () => {
    if (!(await confirm(cancelAllConfirm(active)))) return;
    await run(() => actions.cancelAllTasks(), ACTION_ERROR.cancelTask);
  };

  const header = (
    <PageHeader
      key="header"
      titleId={titleId}
      title={PAGE_LABEL.tasks}
      subtitle={active.length > 0 ? TASKS_COPY.subtitleActive(buckets.running.length, buckets.queued.length) : TASKS_COPY.subtitleIdle}
      actions={
        <>
          {active.length >= 2 && (
            <Button variant="ghost" icon="x" onClick={() => void cancelAll()}>
              {TASKS_COPY.cancelAll}
            </Button>
          )}
          <Button variant="secondary" icon="trash" disabled={buckets.finished.length === 0} onClick={() => actions.clearFinishedTasks()}>
            {TASKS_COPY.clearFinished(buckets.finished.length)}
          </Button>
        </>
      }
    />
  );

  // 断网时进行中的任务照常由后端重试，本页如实呈现；只有重试这个必然失败的入口置灰
  const offlineBanner = online ? null : (
    <Banner key="offline" tone="warn" title={TASKS_COPY.offline.title}>
      {TASKS_COPY.offline.body}
    </Banner>
  );

  const loadError =
    slice.kind === "error" ? (
      <Card key="load-error">
        <Callout
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void run(() => actions.reload("tasks"), BOOT_SLICE_ERROR.tasks)}>
              {TASKS_COPY.loadError.retry}
            </Button>
          }
        >
          <span className={styles.errorLine}>{BOOT_SLICE_ERROR.tasks}</span>
          <span className={styles.errorDetail}>{describeError(slice.error)}</span>
        </Callout>
      </Card>
    ) : null;

  let body: ReactNode[];
  if (tasks.length > 0) {
    body = [
      <TasksOverview key="overview" />,
      <EntranceBlock key="filter" className={styles.listHead}>
        <SegmentedControl
          ariaLabel={TASKS_COPY.filter.ariaLabel}
          value={filter}
          onChange={(next) => nav.replace(filterRoute(next))}
          options={TASK_FILTERS.map((f) => ({ value: f, label: TASKS_COPY.filter[f], count: counts[f] }))}
        />
      </EntranceBlock>,
      <TaskList
        key="list"
        buckets={buckets}
        filter={filter}
        tasks={tasks}
        now={now}
        hasInstance={(id) => instanceIds.includes(id)}
        retryBlocked={online ? undefined : TASKS_COPY.offline.retryReason}
        onCancel={(task) => void cancel(task)}
        onRetry={(task) => void run(() => actions.retryTask(task.id), ACTION_ERROR.install)}
        onViewBlocked={(task) => {
          if (task.error?.blocked_files === undefined) throw new Error(`任务 ${task.id} 没有需要手动下载的文件清单`);
          setBlocked({ open: true, files: task.error.blocked_files, taskId: task.id });
        }}
        onViewInstance={(id) => nav.go({ page: "instance", id, tab: "overview" })}
      />,
    ];
  } else if (slice.kind === "loading" || showSkeleton) {
    // 骨架出现后即使数据已到也要停够最短时长，期间不切到空状态
    body = showSkeleton ? [<TasksSkeleton key="skeleton" slow={gate.slow} />] : [];
  } else if (slice.kind === "error") {
    // 任务记录读不出来时不能说「队列是空的」：只给错误与重试
    body = [];
  } else {
    body = [
      <Card key="empty" padding="lg">
        <EmptyState
          scene="empty-basket"
          titleAs="h2"
          title={TASKS_COPY.empty.title}
          body={TASKS_COPY.empty.body}
          action={
            <div className={styles.emptyActions}>
              <Button variant="secondary" icon="compass" onClick={() => nav.go({ page: "discover" })}>
                {TASKS_COPY.empty.discover}
              </Button>
              <Button variant="secondary" icon="plus" onClick={() => openCreateInstance()}>
                {TASKS_COPY.empty.create}
              </Button>
            </div>
          }
        />
      </Card>,
    ];
  }

  return (
    <ThroughputScope>
      <Page aria-labelledby={titleId}>
        {header}
        {offlineBanner}
        {loadError}
        {body}
      </Page>
      {blocked !== null && (
        <BlockedFilesModal
          open={blocked.open}
          files={blocked.files}
          origin="failed"
          onClose={() => setBlocked({ ...blocked, open: false })}
          onAllFound={() => {
            setBlocked({ ...blocked, open: false });
            void run(() => actions.retryTask(blocked.taskId), ACTION_ERROR.install);
          }}
        />
      )}
    </ThroughputScope>
  );
}

// ---------------------------------------------------------------- 总览

/** 吞吐卡与通道卡：读活动任务的实时进度与速度，每次进度更新都重渲染。 */
function TasksOverview() {
  const active = useLauncherSelector((s) => s.tasks.filter(isActiveTask), shallowArrayEqual);
  const history = readThroughputHistory();
  const buckets = bucketTasks(active);
  return (
    <EntranceBlock className={styles.overview}>
      <ThroughputCard overview={overviewOf(buckets)} history={history} />
      <LanesCard running={buckets.running} queued={buckets.queued} />
    </EntranceBlock>
  );
}

// ---------------------------------------------------------------- 列表

interface RowHandlers {
  hasInstance(id: string): boolean;
  /** 重试眼下必然失败（断网）时的原因；能重试为 undefined。 */
  retryBlocked: string | undefined;
  onCancel(task: Task): void;
  onRetry(task: Task): void;
  onViewBlocked(task: Task): void;
  onViewInstance(id: string): void;
}

interface TaskListProps extends RowHandlers {
  buckets: TaskBuckets;
  filter: TaskFilter;
  tasks: readonly Task[];
  now: number;
}

/**
 * 列表里的一行，各种状态共用这一个部件：排队轮到运行时行原地更新。按状态换成不同的部件会拆掉整行重建，
 * 键盘焦点从它的取消键上掉回页面开头。
 * 运行中的任务自己订阅这一个任务的实时进度，剩余时间按最近几秒的采样估；排队与已结束的进度不再变，沿用页面给的对象，
 * 也不读采样，不随进度与每秒换的采样重渲染。
 */
function TaskListRow({ task: placed, queuePosition, now, handlers }: { task: Task; queuePosition: number | null; now: number; handlers: RowHandlers }) {
  const running = placed.status === "running";
  const task = useLauncherSelector((s) => (running ? s.tasks.find((t) => t.id === placed.id) : placed));
  if (task === undefined) throw new Error(`任务 ${placed.id} 已不在任务表里，列表却还在画它`);
  const meta = rowMeta(task, { queuePosition, etaSpeed: running ? etaSpeed(readThroughputHistory(), task) : 0, now });
  return (
    <TaskRow
      task={task}
      meta={meta}
      hasInstance={task.instanceId !== null && handlers.hasInstance(task.instanceId)}
      retryBlocked={handlers.retryBlocked}
      onCancel={() => handlers.onCancel(task)}
      onRetry={() => handlers.onRetry(task)}
      onViewBlocked={() => handlers.onViewBlocked(task)}
      onViewInstance={() => {
        if (task.instanceId === null) throw new Error(`任务 ${task.id} 没有关联实例`);
        handlers.onViewInstance(task.instanceId);
      }}
    />
  );
}

function TaskList({ buckets, filter, tasks, now, ...handlers }: TaskListProps) {
  const idBase = useId();
  const groups = taskGroups(buckets, filter);
  if (groups.length === 0) {
    if (filter === "all") throw new Error("任务表不为空，「全部」筛选下却没有任何分组");
    const copy = TASKS_COPY.filterEmpty[filter];
    return (
      <Card padding="none">
        <EmptyState compact scene="empty-branch" title={copy.title} body={"body" in copy ? copy.body : undefined} />
      </Card>
    );
  }
  return (
    <Card padding="none">
      {groups.map((group) => {
        const rows = group.tasks.map((task) => (
          <TaskListRow
            key={task.id}
            task={task}
            queuePosition={task.status === "queued" ? queuePosition(tasks, task.id) : null}
            now={now}
            handlers={handlers}
          />
        ));
        if (group.label === null) {
          return (
            <List key={group.key} variant="flush" aria-label={TASKS_COPY.row.listLabel}>
              {rows}
            </List>
          );
        }
        const headingId = `${idBase}-${group.key}`;
        return (
          <section key={group.key} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.groupLabel}>
              {group.label}
            </h2>
            <List variant="flush">{rows}</List>
          </section>
        );
      })}
    </Card>
  );
}

// ---------------------------------------------------------------- 骨架

/** 形状与有任务时的首屏一致：总览的两张卡。读得久了在下方补一行「比平时慢」。 */
function TasksSkeleton({ slow }: { slow: boolean }) {
  return (
    <>
      <EntranceBlock className={styles.overview} aria-busy="true">
        <Skeleton shape="block" width="100%" height={188} radius="lg" />
        <Skeleton shape="block" width="100%" height={188} radius="lg" />
      </EntranceBlock>
      {slow && <p className={styles.slowHint}>{SLOW_LOADING_HINT}</p>}
    </>
  );
}
