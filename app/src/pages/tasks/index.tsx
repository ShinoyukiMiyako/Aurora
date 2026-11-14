// 下载任务页：完整交代下载队列。现在下得多快、三条并行通道各在下什么、谁在排队、每个任务的结局。
// 标题栏的下载快览只管进行中的任务，这一页还负责历史（完成、失败及原因、取消）。
// 状态筛选写在路由上：多个下载失败合并成一条通知时，通知的「查看」直接带着「失败与取消」进页。
//
// 订阅分两层：页面只订阅任务表的结构（增删、换状态），分组、筛选、页头与已结束的行只在结构变化时重排；
// 下载进度每个任务约 100 ms 一次，只交给吞吐卡、通道卡与运行中的那一行，它们各自订阅自己要的那一片。
//
// 动起来的地方：任务完成时进度条先在原处推满、留一拍（lib/progress-display 的收尾），再换到已结束；换组的行从旧位置飞到新位置，
// 两组之间、组内其余的行都滑到新位置。横幅、全部取消、空状态与列表互换都有进出场，骨架与内容叠着交叉淡化。

import { useReducedMotionConfig } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ACTION_ERROR, BOOT_SLICE_ERROR, PAGE_LABEL, SLOW_LOADING_HINT } from "../../copy/flows";
import { TASK_HISTORY_LIMIT } from "../../domain/limits";
import type { Task } from "../../domain/types";
import { useLoadingGate } from "../../lib/loading-gate";
import type { SpringName } from "../../lib/motion";
import { useCompletionHold, useFinishing } from "../../lib/progress-display";
import { followReflow, HOLD_AFTER_RESIZE, observeReflow, REFLOW_MAX_ITEMS, useReflow } from "../../lib/reflow";
import { playTrack, springTrack } from "../../lib/slide";
import { cssVars } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useOnline } from "../../state/online";
import type { PageProps, TaskFilter } from "../../state/route";
import { clearableFinishedCount } from "../../state/selectors";
import type { BlockedFileDto } from "../../state/store";
import { isActiveTask, queuePosition } from "../../state/tasks";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { LabelSlot } from "../../ui/LabelSlot";
import { List } from "../../ui/ListRow";
import { Loadable } from "../../ui/Loadable";
import { EntranceBlock, EntranceBoundary, numberEntrance, Page, useEntranceIndex } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { BlockedFilesModal } from "../discover/BlockedFilesModal";
import { FILTER_SKELETON_WIDTH, LIST_SKELETON_ROWS, OVERVIEW_HEIGHT, RELATIVE_TIME_REFRESH_MS } from "./constants";
import { TASKS_COPY } from "./copy";
import { useChartFrame } from "./hooks";
import { LanesCard } from "./LanesCard";
import {
  bucketTasks,
  cancelAllConfirm,
  cancelConfirm,
  etaSpeed,
  filterCounts,
  filterOf,
  filterRoute,
  finishedAtOf,
  listBuckets,
  overviewOf,
  overviewTrack,
  retryNeedsNetwork,
  sameTaskLayout,
  subtitleOf,
  TASK_FILTERS,
  taskGroups,
  type TaskGroup,
} from "./model";
import styles from "./tasks.module.css";
import { TASK_ROW_ATTR, TaskRow } from "./TaskRow";
import { readThroughputHistory, ThroughputScope } from "./throughput";
import { ThroughputCard } from "./ThroughputCard";

/** 计数按几位数字定宽：已结束的任务最多留 TASK_HISTORY_LIMIT 条，计数到得了三位，跨位数时筛选与按钮都不变宽。 */
const COUNT_DIGITS = String(TASK_HISTORY_LIMIT).length;

/** 总览行至少与骨架一样高：骨架换成内容时下面的筛选与列表不动。 */
const OVERVIEW_STYLE = cssVars({ "--tasks-overview-h": `${OVERVIEW_HEIGHT}px` });

/**
 * 换组的行的飞行与分组之间的让位共用这条弹簧。最后一个进行中的任务完成时，进行中那组整块退场、已结束组被让位带上去，
 * 组里新来的那一行又从旧位置飞过来：量飞行终点时已带上分组的位移，两段方向相反、起点几乎抵消。弹簧不同就衰减得不同步，
 * 叠起来行先偏出去再折回（让出一行任务的高度时约 20 px）。取 settle：内容区、组内与列表行的让位都走它，
 * 飞行跟它一致，套在哪一层里都同步。
 * 两层还要同一帧起步：起步差一帧，露出的就是单层弹簧在这一帧走的那一截，60 Hz 下偏出约 20 px，与弹簧不同时同一量级。
 * 分组的让位从静止起步时停在起点、等新排布画出来才计时，上一段没走完又被挤时旧轨迹接着走、这一趟的位移原样留着等新排布画出来；
 * 飞行跟着分组这一趟走，见 flyAcross。
 */
const TASK_MOVE_SPRING: SpringName = "settle";

export default function TasksPage({ route }: PageProps<"tasks">) {
  // 运行中任务的对象在这里停在上一次结构变化时：它们的进度只由下面的进度部件读
  const tasks = useLauncherSelector((s) => s.tasks, sameTaskLayout);
  const slice = useLauncherSelector((s) => s.status.tasks);
  const unseenFailures = useLauncherSelector((s) => s.unseenFailures);
  const instanceIds = useLauncherSelector((s) => s.instances.map((i) => i.id), shallowArrayEqual);
  // 「清除已结束」的计数按点了真能清掉的算：落地中的任务清除会留着，不计
  const finishedCount = useLauncherSelector(clearableFinishedCount);
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
  const finishing = useFinishing(
    buckets.done.map((t) => ({ id: t.id, finishedAt: finishedAtOf(t) })),
    useCompletionHold(),
  );

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
      className={styles.header}
      titleId={titleId}
      title={PAGE_LABEL.tasks}
      subtitle={subtitleOf(buckets)}
      actions={
        <div className={styles.headerActions}>
          {/* 动作区靠右：全部取消出现、消失时淡入淡出，右侧的清除按钮不动；退场时按页头定位留在原处（见样式里的 .header） */}
          <Appear>
            {active.length >= 2 && (
              <Button key="cancel-all" variant="ghost" icon="x" onClick={() => void cancelAll()}>
                {TASKS_COPY.cancelAll}
              </Button>
            )}
          </Appear>
          <Button variant="secondary" icon="trash" disabled={finishedCount === 0} onClick={() => actions.clearFinishedTasks()}>
            {/* 带不带计数、计数几位，按钮都按最宽的那条占位：首个任务结束时不会把全部取消推开 */}
            <span className={styles.countLabel}>
              <LabelSlot
                current={TASKS_COPY.clearFinished(finishedCount)}
                options={[TASKS_COPY.clearFinished(0), TASKS_COPY.clearFinished(finishedCount), TASKS_COPY.clearFinished(TASK_HISTORY_LIMIT)]}
              />
            </span>
          </Button>
        </div>
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

  const body = (): ReactNode => {
    if (tasks.length > 0) {
      const groups = taskGroups(listBuckets(tasks, finishing), filter);
      return (
        <TasksContent key="tasks" finishing={finishing}>
          <EntranceBlock key="filter" className={styles.listHead}>
            <SegmentedControl
              ariaLabel={TASKS_COPY.filter.ariaLabel}
              value={filter}
              onChange={(next) => nav.replace(filterRoute(next))}
              options={TASK_FILTERS.map((f) => ({ value: f, label: TASKS_COPY.filter[f], count: counts[f] }))}
              countDigits={COUNT_DIGITS}
            />
          </EntranceBlock>
          <TaskList
            key="list"
            groups={groups}
            filter={filter}
            finishing={finishing}
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
          />
        </TasksContent>
      );
    }
    // 任务记录读不出来时不能说「队列是空的」：只给上面的错误与重试
    if (slice.kind === "error") return null;
    // 空状态卡直接领加载区的入场序号：赶上页面首帧时跟着页面错开入场，之后才换上来的由 Loadable / Appear 清空序号、整块淡入
    return (
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
      </Card>
    );
  };

  return (
    <ThroughputScope>
      <Page aria-labelledby={titleId}>
        {header}
        <BannerSlot>
          {offlineBanner}
          {loadError}
        </BannerSlot>
        {/* 骨架出现后即使数据已到也要停够最短时长；之后骨架叠在上面淡出，内容（总览与列表，或空状态）淡入 */}
        <Loadable view={gate.view} skeleton={<TasksSkeleton />}>
          {() => <Appear>{body()}</Appear>}
        </Loadable>
        {/* 慢提示在骨架层外面：骨架层对读屏隐藏，提示要读得到。骨架的几何不含它，它出现时下面没有别的区块要让 */}
        <Appear>
          {gate.view !== "content" && gate.slow && (
            <p key="slow" className={styles.slowHint}>
              {SLOW_LOADING_HINT}
            </p>
          )}
        </Appear>
      </Page>
      {blocked !== null && (
        <BlockedFilesModal
          open={blocked.open}
          files={blocked.files}
          origin="failed"
          onClose={() => setBlocked({ ...blocked, open: false })}
          onAllFound={() => {
            setBlocked({ ...blocked, open: false });
            // 与行上的重试同一口径：断网时重排必然又失败一次，白白多出一次尝试
            if (!online) {
              actions.toast("warning", TASKS_COPY.offline.title, TASKS_COPY.offline.retryReason);
              return;
            }
            void run(() => actions.retryTask(blocked.taskId), ACTION_ERROR.install);
          }}
        />
      )}
    </ThroughputScope>
  );
}

// ---------------------------------------------------------------- 内容区

/**
 * 有任务时的内容：总览、筛选、列表竖排，某一块变高变矮时其余的滑到新位置。children 是总览之后的各块，各带 key。
 * 赶上页面首帧时，三块接着加载区分到的入场序号逐块错开入场。之后才挂上的（读完任务记录换下骨架、空状态与列表互换）
 * 序号已被 Loadable / Appear 清空，这里拿到 null，三块不再各自入场，由外层整块淡入，免得透明度乘两遍。
 */
function TasksContent({ finishing, children }: { finishing: ReadonlySet<string>; children: ReactNode }) {
  const start = useEntranceIndex();
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={styles.content}>
      {numberEntrance([<TasksOverview key="overview" finishing={finishing} />, children], start)}
    </div>
  );
}

// ---------------------------------------------------------------- 总览

/** 吞吐卡与通道卡：读活动任务（连同还在收尾的）的实时进度与速度，每次进度更新都重渲染。 */
function TasksOverview({ finishing }: { finishing: ReadonlySet<string> }) {
  const shown = useLauncherSelector((s) => s.tasks.filter((t) => isActiveTask(t) || finishing.has(t.id)), shallowArrayEqual);
  const active = shown.filter(isActiveTask);
  const history = readThroughputHistory();
  const frame = useChartFrame(history);
  const buckets = bucketTasks(active);
  const overview = overviewOf(buckets);
  return (
    <EntranceBlock className={styles.overview} style={OVERVIEW_STYLE}>
      <ThroughputCard overview={overview} track={overviewTrack(active)} history={history} frame={frame} />
      <LanesCard running={buckets.running} finishing={shown.filter((t) => !isActiveTask(t))} queued={buckets.queued} />
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
  groups: readonly TaskGroup[];
  filter: TaskFilter;
  /** 还在收尾的任务：行留在进行中，进度条推满。 */
  finishing: ReadonlySet<string>;
  tasks: readonly Task[];
  now: number;
}

/**
 * 列表里的一行，各种状态共用这一个部件：排队轮到运行时行原地更新。按状态换成不同的部件会拆掉整行重建，
 * 键盘焦点从它的取消键上掉回页面开头。
 * 运行中的任务自己订阅这一个任务的实时进度，剩余时间按最近几秒的采样估；排队与已结束的进度不再变，沿用页面给的对象，
 * 也不读采样，不随进度与每秒换的采样重渲染。
 */
function TaskListRow({ task: placed, finishing, queuePosition, now, handlers }: { task: Task; finishing: boolean; queuePosition: number | null; now: number; handlers: RowHandlers }) {
  const running = placed.status === "running";
  // 读不到时沿用上一次读到的。任务从表里拿掉是结构变化，在场的行随即被页面撤走，碰上这种情况的只有退场副本（见下）：
  // 淡出途中任务被「清除已结束」拿掉，照拿掉前的样子淡完。不退回 placed：运行中的 placed 停在上一次结构变化时，
  // 进度会倒回去、收尾的满格会换回运行中。行已带 inert，只剩这一百多毫秒；挂载时就读不到仍是列表的错，照样抛
  const task = useLauncherSelector(
    (s) => (running ? s.tasks.find((t) => t.id === placed.id) : placed),
    (prev, next) => next === undefined || prev === next,
  );
  if (task === undefined) throw new Error(`任务 ${placed.id} 已不在任务表里，列表却还在画它`);
  // 退场中的行 props 停在离开前的那次渲染（AnimatePresence 冻结），任务却照样按实时订阅读。减少动画时没有收尾这一拍
  // （useCompletionHold 为 0），完成的那一刻行就离开进行中，原处淡出的那份拿着 finishing=false 读到已完成，会在淡出时
  // 换成已结束的样子：进度条、百分数与取消键撤掉，整行变淡。在场的行换状态时页面总会给新的对象，运行中的 placed
  // 碰上已完成的任务只会是这样的退场副本（行离开分组或整组退场都是），按收尾画，与有收尾这一拍时离开前的样子相同。
  const holding = finishing || (running && task.status === "done");
  return (
    <TaskRow
      task={task}
      finishing={holding}
      meta={{ queuePosition, etaSpeed: running ? etaSpeed(readThroughputHistory(), task) : 0, now }}
      hasInstance={task.instanceId !== null && handlers.hasInstance(task.instanceId)}
      retryBlocked={retryNeedsNetwork(task) ? handlers.retryBlocked : undefined}
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

/** 元素的中心点：新行入场时带着 0.98 的缩放，量中心不受缩放影响。 */
function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 换组的行：旧组里那一行已经脱离布局、在原处淡出，新组里同一个任务的新行从它的位置沿 TASK_MOVE_SPRING 飞到自己的位置，
 * 两者叠着交接，看上去是同一行换了地方。
 * 量的时机放在下一次尺寸观察的回调里：所在分组被挤开后的让位在那一轮观察里才起步，这个观察者建得晚、回调排在它们之后，
 * 量到的新位置已经带着分组的让位，飞的距离不会把分组的位移再算一遍。都在绘制之前，新行不会先在终点露一帧。
 * 建好的飞行跟着新行所在分组包裹层这一趟的让位起步（lib/reflow 的 followReflow），起步时刻与它同一帧定下：
 * - 分组从静止起步、停在起点等新排布画出来（增删观察报出的隔两帧、尺寸观察报出的隔一帧）：飞行也停在起点，挂进同一个等待，
 *   在同一个动画帧回调里开播。建好就播的话比分组早一到两帧。
 * - 分组上一段还没走完又被挤：旧轨迹接着走，这一趟的位移原样留着、等新排布画出来；飞行也停在起点，挂进分组这一趟的同一项等待，
 *   到期时分组换上从那一刻的位置与速度起步的整段，飞行在同一个回调里开播，两段钉同一个起步时刻。
 * - 分组没被挪动：飞行按从静止起步处理，等量的这一帧把新排布画出来，下一帧再播。
 */
function flyAcross(root: HTMLElement, ids: readonly string[]): void {
  if (typeof root.animate !== "function" || typeof ResizeObserver === "undefined") return;
  const probe = new ResizeObserver(() => {
    probe.disconnect();
    for (const id of ids) {
      let leaving: HTMLElement | null = null;
      let arriving: HTMLElement | null = null;
      for (const mark of root.querySelectorAll(`[${TASK_ROW_ATTR}="${CSS.escape(id)}"]`)) {
        const row = mark.closest("li");
        if (row === null) continue;
        if (row.closest("[inert]") === null) arriving = row;
        else leaving = row;
      }
      if (leaving === null || arriving === null) continue;
      const from = centerOf(leaving);
      const to = centerOf(arriving);
      followReflow(playTrack(arriving, springTrack(TASK_MOVE_SPRING, from.x - to.x, 0, from.y - to.y, 0)), groupItemOf(root, arriving), HOLD_AFTER_RESIZE);
    }
  });
  probe.observe(root);
}

/** el 所在的分组包裹层：root 的直接子项，分组之间的让位挪的是它。 */
function groupItemOf(root: HTMLElement, el: HTMLElement): HTMLElement {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) if (node.parentElement === root) return node;
  throw new Error("换组的行不在分组容器里");
}

function TaskList({ groups, filter, finishing, tasks, now, ...handlers }: TaskListProps) {
  const idBase = useId();
  const reduced = useReducedMotionConfig() === true;
  const root = useRef<HTMLDivElement | null>(null);
  // 分组之间互相让位：某组增删行、组标题出现消失时，下面的组滑到新位置
  const attach = useCallback((el: HTMLDivElement | null) => {
    root.current = el;
    if (el === null) return;
    const stop = observeReflow(el, TASK_MOVE_SPRING);
    return () => {
      root.current = null;
      stop();
    };
  }, []);

  // 上一次提交时每个任务在哪一组：换了组的行要从旧位置飞过去
  const placement = useRef<ReadonlyMap<string, TaskGroup["key"]> | null>(null);
  useLayoutEffect(() => {
    const next = new Map(groups.flatMap((g) => g.tasks.map((t) => [t.id, g.key] as const)));
    const before = placement.current;
    placement.current = next;
    if (before === null || reduced || root.current === null) return;
    const moved = [...next].filter(([id, key]) => before.has(id) && before.get(id) !== key).map(([id]) => id);
    if (moved.length === 0 || moved.length > REFLOW_MAX_ITEMS) return;
    flyAcross(root.current, moved);
  });

  if (groups.length === 0 && filter === "all") throw new Error("任务表不为空，「全部」筛选下却没有任何分组");
  return (
    <Card padding="none">
      <div ref={attach} className={styles.groups}>
        <Appear>
          {groups.map((group) => (
            <TaskGroupBlock key={group.key} group={group} headingId={`${idBase}-${group.key}`}>
              {group.tasks.map((task) => (
                <TaskListRow
                  key={task.id}
                  task={task}
                  finishing={finishing.has(task.id)}
                  queuePosition={task.status === "queued" ? queuePosition(tasks, task.id) : null}
                  now={now}
                  handlers={handlers}
                />
              ))}
            </TaskGroupBlock>
          ))}
          {groups.length === 0 && filter !== "all" && <FilterEmpty key={`empty-${filter}`} filter={filter} />}
        </Appear>
      </div>
    </Card>
  );
}

/**
 * 一组任务。组标题只在「全部」里有，换筛选时淡入淡出，下面的列表随之滑动；组内行的增删由 List 自己动。
 * 换筛选时同一组沿用同一个容器（分组的键见 model），列表不重建，留下的行原地不动。
 */
function TaskGroupBlock({ group, headingId, children }: { group: TaskGroup; headingId: string; children: ReactNode }) {
  const reflow = useReflow<HTMLElement>();
  return (
    <section ref={reflow} className={styles.group} aria-labelledby={group.label === null ? undefined : headingId}>
      <Appear>
        {group.label !== null && (
          <h2 key="label" id={headingId} className={styles.groupLabel}>
            {group.label}
          </h2>
        )}
      </Appear>
      <List variant="flush" aria-label={group.label === null ? TASKS_COPY.row.listLabel : undefined}>
        {children}
      </List>
    </section>
  );
}

function FilterEmpty({ filter }: { filter: Exclude<TaskFilter, "all"> }) {
  const copy = TASKS_COPY.filterEmpty[filter];
  return <EmptyState compact scene="empty-branch" title={copy.title} body={"body" in copy ? copy.body : undefined} />;
}

// ---------------------------------------------------------------- 骨架

/**
 * 形状照有任务时的内容画：总览两张卡（与总览行同高）、筛选条、带组标题的几行任务。
 * 它自己不参与页面入场：等待期它透明占位，到点由加载容器淡入。
 */
function TasksSkeleton() {
  return (
    <EntranceBoundary>
      <div className={styles.content}>
        <div className={styles.overview} style={OVERVIEW_STYLE}>
          <Skeleton shape="block" width="100%" height={OVERVIEW_HEIGHT} radius="lg" />
          <Skeleton shape="block" width="100%" height={OVERVIEW_HEIGHT} radius="lg" />
        </div>
        <div className={styles.listHead}>
          <Skeleton shape="block" width={FILTER_SKELETON_WIDTH} height={36} radius="sm" />
        </div>
        <Card padding="none">
          <div className={styles.groupLabel}>
            <Skeleton shape="text" width="12%" />
          </div>
          {Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton shape="square" size={44} />
              <span className={styles.skeletonBody}>
                <Skeleton shape="text" width="36%" className={styles.skeletonTitle} />
                <Skeleton shape="text" width="58%" className={styles.skeletonMeta} />
              </span>
            </div>
          ))}
        </Card>
      </div>
    </EntranceBoundary>
  );
}
