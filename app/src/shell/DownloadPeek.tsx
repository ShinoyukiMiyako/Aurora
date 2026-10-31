// 下载快览：标题栏右列的下载入口与它的浮层。入口空闲时是下载图标；有进行中的任务时换成总进度环 + 计数角标；
// 外壳挂载之后有任务失败、用户还没看过时挂一个危险点，打开快览或进入下载任务页即算看过。
// 浮层只列进行中的任务（运行在前、排队在后，各自保持队列顺序），已结束的去下载任务页看。

import { useEffect, useRef, useState } from "react";
import { Icon } from "../art/Icon";
import { ACTION_ERROR, CONFIRM_COPY } from "../copy/flows";
import { formatSpeed, percent } from "../domain/format";
import type { Task } from "../domain/types";
import type { ConfirmOptions } from "../launch/host";
import { useLauncher } from "../state/launcher";
import { findInstance } from "../state/selectors";
import type { LauncherState } from "../state/store";
import { attemptTaskId, isActiveTask, isFinishedTask } from "../state/tasks";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Popover } from "../ui/Popover";
import { ProgressBar } from "../ui/ProgressBar";
import { ProgressRing } from "../ui/ProgressRing";
import { PEEK_COPY } from "../copy/shell";
import styles from "./DownloadPeek.module.css";
import { useNav, useShell } from "./shell";
import { useRunner } from "./useRunner";

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

/** 浮层的列表顺序：运行中在前、排队在后，两组内部保持队列（数组）顺序。 */
export function peekRows(tasks: readonly Task[]): Task[] {
  return [...tasks.filter((t) => t.status === "running"), ...tasks.filter((t) => t.status === "queued")];
}

/** 外壳挂载之后失败、还没被看过的尝试。按尝试 id 记，重试之后再失败算新的一次。 */
export function unseenFailures(tasks: readonly Task[], since: number, seen: ReadonlySet<string>): Task[] {
  return tasks.filter((t) => t.status === "failed" && t.finishedAt !== null && t.finishedAt >= since && !seen.has(attemptTaskId(t)));
}

/**
 * 取消一个任务前要不要确认：排队中的直接取消；运行中的新建与导入取消后实例会被删除，
 * 修复取消后实例停在文件不完整的状态，这两类要确认；其余直接取消。
 */
export function cancelTaskConfirm(state: LauncherState, task: Task): ConfirmOptions | null {
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
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const { route, go } = useNav();
  const run = useRunner();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const mountedAt = useRef(Date.now());
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  const tasks = state.tasks;
  const active = tasks.filter(isActiveTask);
  const unseen = unseenFailures(tasks, mountedAt.current, seen);
  const onTasksPage = route.page === "tasks";

  // 打开快览或停在下载任务页时，失败即被看到
  const unseenKey = unseen.map(attemptTaskId).join("|");
  useEffect(() => {
    if (unseenKey === "" || (!open && !onTasksPage)) return;
    setSeen((prev) => new Set([...prev, ...unseenKey.split("|")]));
  }, [onTasksPage, open, unseenKey]);

  const close = () => setOpen(false);
  const leaveTo = (filter?: "failed") => {
    close();
    go(filter === undefined ? { page: "tasks" } : { page: "tasks", filter });
  };
  const cancel = (task: Task) =>
    void run(async () => {
      const options = cancelTaskConfirm(state, task);
      if (options !== null && !(await confirm(options))) return;
      await actions.cancelTask(task.id);
    }, ACTION_ERROR.cancelTask);

  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const finishedCount = tasks.filter(isFinishedTask).length;
  const rows = peekRows(tasks);

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={styles.entry}
        aria-label={PEEK_COPY.button(active.length, unseen.length)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-open={open || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {active.length === 0 ? <Icon name="download" size={18} /> : <ActiveGlyph tasks={tasks} />}
        {active.length > 0 && <Badge className={styles.count} count={active.length} tone="accent" ring />}
        {unseen.length > 0 && <span className={styles.failDot} data-alone={active.length === 0 || undefined} aria-hidden="true" />}
      </button>
      <Popover open={open} anchor={anchor} onClose={close} placement="bottom-end" aria-label={PEEK_COPY.title}>
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.headTitle}>{PEEK_COPY.title}</span>
            <span className={styles.headMeta}>{active.length > 0 ? PEEK_COPY.activeSummary(active.length) : PEEK_COPY.idle}</span>
          </div>
          {rows.length > 0 ? (
            <ul className={styles.list}>
              {rows.map((task) => (
                <PeekRow key={task.id} task={task} onCancel={() => cancel(task)} />
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>{PEEK_COPY.empty}</p>
          )}
          {failedCount > 0 && (
            <div className={styles.failed}>
              <Icon name="x-circle" size={16} />
              <span className={styles.failedText}>{PEEK_COPY.failed(failedCount)}</span>
              <Button variant="ghost" size="sm" onClick={() => leaveTo("failed")}>
                {PEEK_COPY.view}
              </Button>
            </div>
          )}
          <div className={styles.foot}>
            {finishedCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => actions.clearFinishedTasks()}>
                {PEEK_COPY.clearFinished(finishedCount)}
              </Button>
            )}
            <Button variant="secondary" size="sm" iconRight="arrow-right" onClick={() => leaveTo()}>
              {PEEK_COPY.allTasks}
            </Button>
          </div>
        </div>
      </Popover>
    </>
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
        <ProgressRing value={progress} size={24} label={PEEK_COPY.totalProgress} />
      )}
      <span className={styles.glyphIcon}>
        <Icon name="download" size={12} />
      </span>
    </span>
  );
}

function PeekRow({ task, onCancel }: { task: Task; onCancel: () => void }) {
  const queued = task.status === "queued";
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.rowTitle} title={task.title}>
          {task.title}
        </span>
        <IconButton icon="x" size="sm" label={PEEK_COPY.cancel} tooltipSide="left" onClick={onCancel} />
      </div>
      <ProgressBar value={queued ? 0 : task.progress} tone={queued ? "muted" : "accent"} size="sm" track={attemptTaskId(task)} label={PEEK_COPY.rowProgress(task.title)} />
      <div className={styles.rowMeta}>
        <span className={styles.rowDetail}>{task.detail}</span>
        <span className={styles.rowState}>{queued ? PEEK_COPY.queued : PEEK_COPY.progress(percent(task.progress), formatSpeed(task.speedBps))}</span>
      </div>
    </li>
  );
}
