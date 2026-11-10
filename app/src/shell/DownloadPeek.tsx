// 下载快览：标题栏右列的下载入口与它的浮层。入口空闲时是下载图标；有进行中的任务时换成总进度环 + 计数角标；
// 有用户还没看过的失败任务时挂一个危险点（未看标记归状态层），打开快览即算看过，进入下载任务页由那一页清除。
// 浮层只列进行中的任务（运行在前、排队在后，各自保持队列顺序），已结束的去下载任务页看。
//
// 动效：图标与进度环叠在同一格交叉淡入，角标与危险点出现时弹入、消失时淡出缩小，入口尺寸始终不变；
// 账户胶囊伸缩时入口跟着胶囊左缘滑（SLIDES_WITH_CAPSULE）；浮层里任务行增删时淡入淡出，其余行从旧位置滑到新位置。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../art/Icon";
import { ACTION_ERROR, CONFIRM_COPY, taskPhaseText } from "../copy/flows";
import { formatSpeed, percent } from "../domain/format";
import type { Task } from "../domain/types";
import type { ConfirmOptions } from "../launch/host";
import { fade, insertItem, springs } from "../lib/motion";
import { useReflow } from "../lib/reflow";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { findInstance } from "../state/selectors";
import type { LauncherState } from "../state/store";
import { isActiveTask, isFinishedTask, progressTrack } from "../state/tasks";
import { Appear } from "../ui/Appear";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Popover } from "../ui/Popover";
import { ProgressBar } from "../ui/ProgressBar";
import { ProgressRing } from "../ui/ProgressRing";
import { PEEK_COPY } from "../copy/shell";
import { SLIDES_WITH_CAPSULE } from "./AccountCapsule";
import styles from "./DownloadPeek.module.css";
import { useNav, useShell } from "./shell";
import { useRunner } from "./useRunner";

/** 角标与提醒点：出现时从零弹入，消失时淡出并缩到 0.6。 */
const MARK = {
  initial: { opacity: 0, scale: 0 },
  animate: { opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } },
  exit: { opacity: 0, scale: 0.6, transition: fade.out },
} as const;

/** 挂载时就在的元素跟着外壳或浮层一起出现，不单独播入场；之后才挂上的才播。读这个 ref 决定 initial。 */
function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return mounted;
}

/**
 * 入口上的总进度：按声明大小加权（Σ 大小 × 进度 / Σ 大小）。大小都未知时为 null，入口画静态虚线环；
 * 大小未知的任务不参与加权，免得一个没有大小的小文件把总进度拉成它自己的进度。
 */
export function overallProgress(tasks: readonly Task[]): number | null {
  let total = 0;
  let done = 0;
  for (const task of tasks) {
    if (!isActiveTask(task) || task.totalBytes === null || task.totalBytes <= 0) continue;
    total += task.totalBytes;
    done += task.totalBytes * task.progress;
  }
  return total === 0 ? null : done / total;
}

/**
 * 总进度环的标识：活动任务连同各自所在的批次。有任务结束或入队、某个任务换了批次时标识就变，
 * 环直接跳到按新集合加权的值，不从旧值倒退着动画过去；标识不变时只增不减。
 */
export function overallTrack(tasks: readonly Task[]): string {
  return tasks.filter(isActiveTask).map(progressTrack).sort().join("\n");
}

/** 浮层的列表顺序：运行中在前、排队在后，两组内部保持队列（数组）顺序。 */
export function peekRows(tasks: readonly Task[]): Task[] {
  return [...tasks.filter((t) => t.status === "running"), ...tasks.filter((t) => t.status === "queued")];
}

/**
 * 取消一个任务前要不要确认：排队中的直接取消；运行中的新建与导入取消后实例会被删除，
 * 修复取消后实例停在文件不完整的状态，这两类要确认；其余直接取消。
 */
export function cancelTaskConfirm(state: Pick<LauncherState, "instances">, task: Task): ConfirmOptions | null {
  if (task.status !== "running") return null;
  if (task.kind !== "game" && task.kind !== "modpack" && task.kind !== "repair") return null;
  if (task.instanceId === null) throw new Error(`任务 ${task.id}（${task.kind}）没有目标实例`);
  // 新建中的实例可能还没进实例列表；实例 id 就是它的目录名，可以直接写进文案
  const inst = findInstance(state, task.instanceId);
  const name = inst === undefined ? task.instanceId : inst.name;
  const copy = task.kind === "repair" ? CONFIRM_COPY.cancelRepair(task.title, name) : CONFIRM_COPY.cancelCreate(task.title, name);
  return { ...copy, cancelLabel: CONFIRM_COPY.keepDownloading, tone: "danger" };
}

export function DownloadPeek() {
  // 任务表本身就是这里要显示的高频切片；会话日志与别的变化不让快览重渲染
  const tasks = useLauncherSelector((s) => s.tasks);
  const unseen = useLauncherSelector((s) => s.unseenFailures);
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const { confirm } = useShell();
  const { go } = useNav();
  const run = useRunner();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const mounted = useMountedRef();

  const active = tasks.filter(isActiveTask);

  // 快览开着的时候，失败即被看到（包括开着期间新出现的）
  useEffect(() => {
    if (open && unseen > 0) actions.markFailuresSeen();
  }, [actions, open, unseen]);

  const close = () => setOpen(false);
  const leaveTo = (filter?: "failed") => {
    close();
    go(filter === undefined ? { page: "tasks" } : { page: "tasks", filter });
  };
  const cancel = (task: Task) =>
    void run(async () => {
      const options = cancelTaskConfirm({ instances }, task);
      if (options !== null && !(await confirm(options))) return;
      await actions.cancelTask(task.id);
    }, ACTION_ERROR.cancelTask);

  return (
    <>
      <motion.button
        ref={setAnchor}
        type="button"
        {...SLIDES_WITH_CAPSULE}
        className={styles.entry}
        aria-label={PEEK_COPY.button(active.length, unseen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {/* 空闲图标与进度环叠在同一格交叉淡入：刚点的下载落在这里，入口尺寸不变 */}
        <AnimatePresence>
          {active.length === 0 ? (
            <motion.span
              key="idle"
              className={styles.glyphSlot}
              initial={mounted.current ? { opacity: 0 } : false}
              animate={{ opacity: 1, transition: fade.in }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <Icon name="download" size={18} />
            </motion.span>
          ) : (
            <motion.span
              key="active"
              className={styles.glyphSlot}
              initial={mounted.current ? { opacity: 0, scale: 0.8 } : false}
              animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              <ActiveGlyph tasks={tasks} />
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {active.length > 0 && (
            <motion.span key="count" className={styles.count} initial={mounted.current ? MARK.initial : false} animate={MARK.animate} exit={MARK.exit}>
              <Badge count={active.length} tone="accent" ring />
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {unseen > 0 && (
            <motion.span
              key="failed"
              className={styles.failDot}
              data-alone={active.length === 0 || undefined}
              aria-hidden="true"
              initial={mounted.current ? MARK.initial : false}
              animate={MARK.animate}
              exit={MARK.exit}
            />
          )}
        </AnimatePresence>
      </motion.button>
      <Popover open={open} anchor={anchor} onClose={close} placement="bottom-end" aria-label={PEEK_COPY.title}>
        <PeekPanel tasks={tasks} activeCount={active.length} onCancel={cancel} onLeave={leaveTo} onClearFinished={() => actions.clearFinishedTasks()} />
      </Popover>
    </>
  );
}

interface PeekPanelProps {
  tasks: readonly Task[];
  activeCount: number;
  onCancel: (task: Task) => void;
  onLeave: (filter?: "failed") => void;
  onClearFinished: () => void;
}

/** 浮层内容：随浮层打开挂载，打开时就在的行不单独播入场，开着期间新来的行淡入。 */
function PeekPanel({ tasks, activeCount, onCancel, onLeave, onClearFinished }: PeekPanelProps) {
  const mounted = useMountedRef();
  const list = useReflow<HTMLUListElement>();
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const finishedCount = tasks.filter(isFinishedTask).length;
  const rows = peekRows(tasks);
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{PEEK_COPY.title}</span>
        <span className={styles.headMeta}>{activeCount > 0 ? PEEK_COPY.activeSummary(activeCount) : PEEK_COPY.idle}</span>
      </div>
      {/* 列表与空态先退后进：最后一行跟着列表一起淡出，空态再淡入，退场的列表不脱离布局、不撑出浮层的滚动条 */}
      <AnimatePresence mode="wait">
        {rows.length > 0 ? (
          <motion.div
            key="list"
            className={styles.scroller}
            initial={mounted.current ? { opacity: 0 } : false}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
          >
            <ul ref={list} className={styles.list}>
              {/*
               * 行退场时留在流里淡出，播完才移除，下面的行再滑上来。不用 popLayout：浮层的外框不随内容伸缩，
               * 弹出流外的末行会被立即缩短的滚动区裁掉，看上去仍是硬删
               */}
              <AnimatePresence>
                {rows.map((task) => (
                  <PeekRow key={task.id} task={task} enter={mounted.current} onCancel={() => onCancel(task)} />
                ))}
              </AnimatePresence>
            </ul>
          </motion.div>
        ) : (
          <motion.p
            key="empty"
            className={styles.empty}
            initial={mounted.current ? { opacity: 0 } : false}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
          >
            {PEEK_COPY.empty}
          </motion.p>
        )}
      </AnimatePresence>
      <Appear>
        {failedCount > 0 && (
          <div key="failed" className={styles.failed}>
            <Icon name="x-circle" size={16} />
            <span className={styles.failedText}>{PEEK_COPY.failed(failedCount)}</span>
            <Button variant="ghost" size="sm" onClick={() => onLeave("failed")}>
              {PEEK_COPY.view}
            </Button>
          </div>
        )}
      </Appear>
      <div className={styles.foot}>
        <Appear>
          {finishedCount > 0 && (
            <Button key="clear" variant="ghost" size="sm" onClick={onClearFinished}>
              {PEEK_COPY.clearFinished(finishedCount)}
            </Button>
          )}
        </Appear>
        <Button variant="secondary" size="sm" iconRight="arrow-right" onClick={() => onLeave()}>
          {PEEK_COPY.allTasks}
        </Button>
      </div>
    </div>
  );
}

function ActiveGlyph({ tasks }: { tasks: readonly Task[] }) {
  const progress = overallProgress(tasks);
  return (
    <span className={styles.glyph} aria-hidden="true">
      {progress === null ? (
        <svg className={styles.unknownRing} width={24} height={24} viewBox="0 0 24 24" focusable="false">
          <circle cx={12} cy={12} r={10.75} fill="none" strokeWidth={2.5} strokeDasharray="3 4" />
        </svg>
      ) : (
        <ProgressRing value={progress} size={24} track={overallTrack(tasks)} label={PEEK_COPY.totalProgress} />
      )}
      <span className={styles.glyphIcon}>
        <Icon name="download" size={12} />
      </span>
    </span>
  );
}

function PeekRow({ task, enter, onCancel }: { task: Task; enter: boolean; onCancel: () => void }) {
  const queued = task.status === "queued";
  return (
    <motion.li className={styles.row} initial={enter ? insertItem.initial : false} animate={insertItem.animate} exit={insertItem.exit}>
      <div className={styles.rowHead}>
        <span className={styles.rowTitle} title={task.title}>
          {task.title}
        </span>
        <IconButton icon="x" size="sm" label={PEEK_COPY.cancel} tooltipSide="left" onClick={onCancel} />
      </div>
      <ProgressBar value={queued ? 0 : task.progress} tone={queued ? "muted" : "accent"} size="sm" track={progressTrack(task)} label={PEEK_COPY.rowProgress(task.title)} />
      <div className={styles.rowMeta}>
        <span className={styles.rowDetail}>{queued || task.phase === null ? task.detail : taskPhaseText(task.phase, "short")}</span>
        <span className={styles.rowState}>{queued ? PEEK_COPY.queued : PEEK_COPY.progress(percent(task.progress), formatSpeed(task.speedBps))}</span>
      </div>
    </motion.li>
  );
}
