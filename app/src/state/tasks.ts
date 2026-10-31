// 下载队列的纯函数：入队、调度、进度、结局、重试、历史裁剪与任务日志恢复。真正发命令的是状态容器。
//
// 队列顺序就是数组顺序：入队追加到末尾，重试移到末尾，调度永远取最靠前的 queued，因此「先到先下」与
// 「重试排到队尾」都不需要改写 createdAt。每次尝试的命令 taskId 是「任务 id + 尝试次数」：后端会记住
// 「取消时不在运行」的 id，同 id 再登记会直接是已取消状态，重试必须换新 id。

import { TASK_INTERRUPTED_CODE, taskFailureReason } from "../copy/flows";
import { MAX_PARALLEL_TASKS, TASK_HISTORY_LIMIT } from "../domain/limits";
import type { Task, TaskKind, TaskSpec } from "../domain/types";

export interface TaskDraft {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  instanceId: string | null;
  spec: TaskSpec;
}

export function isActiveTask(task: Task): boolean {
  return task.status === "queued" || task.status === "running";
}

export function isFinishedTask(task: Task): boolean {
  return !isActiveTask(task);
}

/** 这一次尝试发给后端的 taskId；core-event 的 task_id 与它对照。 */
export function attemptTaskId(task: Pick<Task, "id" | "attempt">): string {
  return `${task.id}#${task.attempt}`;
}

/**
 * 去重键：同一资源装到同一实例算同一件事。键里带上命令名，不同命令即使参数相同也不相撞；
 * 没列出的命令按完整参数比较。
 */
export function taskDedupeKey(spec: TaskSpec): string {
  const a = spec.args;
  switch (spec.command) {
    case "install_version":
      return `install_version|${String(a.targetName).toLowerCase()}`;
    case "install_modpack":
      return `install_modpack|${String(a.name).toLowerCase()}`;
    case "repair_instance":
      return `repair_instance|${String(a.id).toLowerCase()}`;
    case "install_java":
      return `install_java|${String(a.requiredMajor)}`;
    case "install_resource":
    case "install_mod":
    case "install_mods":
      return `install|${String(a.versionId).toLowerCase()}|${String(a.platform)}|${String(a.projectId)}`;
    case "update_mod":
      return `update_mod|${String(a.versionId).toLowerCase()}|${String(a.fileName)}`;
    case "update_mods":
      return `update_mods|${String(a.versionId).toLowerCase()}`;
    default:
      return `${spec.command}|${JSON.stringify(a)}`;
  }
}

export function findDuplicate(tasks: readonly Task[], spec: TaskSpec): Task | undefined {
  const key = taskDedupeKey(spec);
  return tasks.find((t) => isActiveTask(t) && taskDedupeKey(t.spec) === key);
}

export function newTask(draft: TaskDraft, now: number): Task {
  return {
    ...draft,
    status: "queued",
    progress: 0,
    bytes: 0,
    totalBytes: null,
    doneBytes: 0,
    speedBps: 0,
    startedAt: null,
    attempt: 1,
    error: null,
    createdAt: now,
    finishedAt: null,
  };
}

/** 有空位时该开始的任务（按队列顺序），已在运行的不算。 */
export function tasksToStart(tasks: readonly Task[]): Task[] {
  const free = MAX_PARALLEL_TASKS - tasks.filter((t) => t.status === "running").length;
  if (free <= 0) return [];
  return tasks.filter((t) => t.status === "queued").slice(0, free);
}

/** queued 任务在队里的位次，从 1 计；不在排队为 null。 */
export function queuePosition(tasks: readonly Task[], id: string): number | null {
  const queued = tasks.filter((t) => t.status === "queued");
  const index = queued.findIndex((t) => t.id === id);
  return index === -1 ? null : index + 1;
}

function update(tasks: readonly Task[], id: string, fn: (task: Task) => Task): Task[] {
  return tasks.map((t) => (t.id === id ? fn(t) : t));
}

export function markRunning(tasks: readonly Task[], id: string, now: number): Task[] {
  return update(tasks, id, (t) =>
    t.status === "queued" ? { ...t, status: "running", progress: 0, bytes: 0, totalBytes: null, doneBytes: 0, speedBps: 0, startedAt: now } : t,
  );
}

/** 后端推来的一批下载的进度快照。 */
export interface DownloadSnapshot {
  total: number;
  finished: number;
  bytes: number;
  totalBytes: number | null;
  speed: number;
}

/** 这一批完成了多少：总字节已知按字节，否则按文件数。 */
function snapshotFraction(event: DownloadSnapshot): number {
  if (event.totalBytes !== null && event.totalBytes > 0) return Math.min(1, event.bytes / event.totalBytes);
  return event.total > 0 ? event.finished / event.total : 0;
}

/**
 * 一批下载的进度快照。一次安装连跑好几批，每批从 0 重新计：进度按当前批次如实显示，
 * 批次内只进不退，新批次（已下字节变少或批次大小变了）从头开始。累计字节跨批次往上加。
 */
export function applyTaskDownload(tasks: readonly Task[], attemptId: string, event: DownloadSnapshot): Task[] {
  return tasks.map((t) => {
    if (t.status !== "running" || attemptTaskId(t) !== attemptId) return t;
    const fraction = snapshotFraction(event);
    const sameBatch = event.totalBytes === t.totalBytes && event.bytes >= t.bytes;
    return {
      ...t,
      progress: sameBatch ? Math.max(t.progress, fraction) : fraction,
      bytes: event.bytes,
      totalBytes: event.totalBytes,
      doneBytes: t.doneBytes + (sameBatch ? event.bytes - t.bytes : event.bytes),
      speedBps: event.speed,
    };
  });
}

// ---------------------------------------------------------------- 组合任务的进度

/** 一批下载的标识：批次总量相同、已下字节没有变少即同一批。 */
interface BatchMark {
  bytes: number;
  totalBytes: number | null;
}

function continues(mark: BatchMark, event: DownloadSnapshot): boolean {
  return event.totalBytes === mark.totalBytes && event.bytes >= mark.bytes;
}

/**
 * 组合任务（逐项调后端命令、共用一个 taskId）的进度游标。后端每一项都从 0 报起，按单项显示的话进度条每换一项归零一次，
 * 只认「只进不退」的进度条则卡在第一项的 100%。这里把各项折成整体进度：
 * - 各项的声明大小都已知时按字节：已做完各项的声明大小加上当前项实际下载的字节，除以声明总量。用实际字节而不是
 *   「当前项的比例 × 它自己的大小」，是因为一次命令可能连带下载别的项（装 Mod 时一并装上缺的前置，后面那几项就无事可做），
 *   按它自己的大小封顶会先卡住再跳到头。
 * - 有一项不知道大小时按项数：每项占一份，当前项按它报来的比例。
 */
export interface CompositeProgress {
  /** 每项的权重：声明大小都已知时为字节数，否则每项为 1。 */
  readonly weights: readonly number[];
  /** 声明大小都已知时为它们的和，作为任务的总量；按项数折算时为 null。 */
  readonly totalBytes: number | null;
  /** 正在进行的那一项；等于项数时已全部做完。 */
  readonly index: number;
  /** 当前项开始时任务的累计下载字节，用来算这一项实际下了多少。 */
  readonly stepStartBytes: number;
  /** 当前项最近一批下载的标识；这一项还没报过进度时为 null。 */
  readonly batch: BatchMark | null;
  /**
   * 之前各项最近的一批。进度事件经后端的转发通道异步送达，上一项的最后几条可能在它的命令返回、下一项已经开始之后才到；
   * 当前项还没报过进度时，接着这一批往下走的快照认作晚到的，丢掉。
   */
  readonly previous: BatchMark | null;
}

export function compositeProgress(sizes: readonly (number | null)[]): CompositeProgress {
  const known = sizes.filter((size): size is number => size !== null);
  const sum = known.reduce((total, size) => total + size, 0);
  const bySize = known.length === sizes.length && sum > 0;
  return {
    weights: bySize ? known : sizes.map(() => 1),
    totalBytes: bySize ? sum : null,
    index: 0,
    stepStartBytes: 0,
    batch: null,
    previous: null,
  };
}

function weightBefore(cursor: CompositeProgress, index: number): number {
  return cursor.weights.slice(0, index).reduce((total, w) => total + w, 0);
}

/** 按整体进度写回任务：只进不退；按字节折算时已下字节与进度一致，按项数折算时取实际累计下载的字节。 */
function withCompositeProgress(task: Task, cursor: CompositeProgress, fraction: number, doneBytes: number): Task {
  const progress = Math.max(task.progress, fraction);
  return {
    ...task,
    progress,
    totalBytes: cursor.totalBytes,
    bytes: cursor.totalBytes === null ? doneBytes : Math.round(progress * cursor.totalBytes),
    doneBytes,
  };
}

function runningAttempt(tasks: readonly Task[], attemptId: string): Task | undefined {
  return tasks.find((t) => t.status === "running" && attemptTaskId(t) === attemptId);
}

/** 组合任务开始：总量一开始就按全部项的声明大小给出，进度环与总进度不必等第一条进度事件。 */
export function startComposite(tasks: readonly Task[], attemptId: string, cursor: CompositeProgress): Task[] {
  return tasks.map((t) => (t.status === "running" && attemptTaskId(t) === attemptId ? withCompositeProgress(t, cursor, 0, t.doneBytes) : t));
}

/** 组合任务当前项的一条下载进度。不属于这一次尝试、晚到的上一项进度、全部做完后再来的进度返回 null，表示不采纳。 */
export function applyCompositeDownload(
  tasks: readonly Task[],
  attemptId: string,
  cursor: CompositeProgress,
  event: DownloadSnapshot,
): { tasks: Task[]; cursor: CompositeProgress } | null {
  const task = runningAttempt(tasks, attemptId);
  if (task === undefined || cursor.index >= cursor.weights.length) return null;
  if (cursor.batch === null && cursor.previous !== null && continues(cursor.previous, event)) return null;
  const sameBatch = cursor.batch !== null && continues(cursor.batch, event);
  const doneBytes = task.doneBytes + (sameBatch && cursor.batch !== null ? event.bytes - cursor.batch.bytes : event.bytes);
  const whole = weightBefore(cursor, cursor.weights.length);
  const before = weightBefore(cursor, cursor.index);
  const fraction =
    cursor.totalBytes === null
      ? (before + cursor.weights[cursor.index] * snapshotFraction(event)) / whole
      : Math.min(1, (before + doneBytes - cursor.stepStartBytes) / whole);
  const next: Task = { ...withCompositeProgress(task, cursor, fraction, doneBytes), speedBps: event.speed };
  return {
    tasks: tasks.map((t) => (t === task ? next : t)),
    cursor: { ...cursor, batch: { bytes: event.bytes, totalBytes: event.totalBytes } },
  };
}

/** 组合任务的当前项做完：整体进度推到这一项的末尾，游标移到下一项。 */
export function completeCompositeStep(tasks: readonly Task[], attemptId: string, cursor: CompositeProgress): { tasks: Task[]; cursor: CompositeProgress } {
  const index = cursor.index + 1;
  if (index > cursor.weights.length) throw new Error(`组合任务 ${attemptId} 只有 ${cursor.weights.length} 项，不能再往下走`);
  const previous = cursor.batch === null ? cursor.previous : cursor.batch;
  const task = runningAttempt(tasks, attemptId);
  if (task === undefined) return { tasks: [...tasks], cursor: { ...cursor, index, batch: null, previous } };
  const next: CompositeProgress = { ...cursor, index, stepStartBytes: task.doneBytes, batch: null, previous };
  const fraction = weightBefore(cursor, index) / weightBefore(cursor, cursor.weights.length);
  const updated = withCompositeProgress(task, cursor, fraction, task.doneBytes);
  return { tasks: tasks.map((t) => (t === task ? updated : t)), cursor: next };
}

/** 根据 core-event 的 task_id 找到这一次尝试对应的任务。 */
export function taskByAttempt(tasks: readonly Task[], attemptId: string): Task | undefined {
  return tasks.find((t) => attemptTaskId(t) === attemptId);
}

export function markDone(tasks: readonly Task[], id: string, attempt: number, now: number): Task[] {
  return update(tasks, id, (t) =>
    t.status === "running" && t.attempt === attempt ? { ...t, status: "done", progress: 1, speedBps: 0, finishedAt: now } : t,
  );
}

export function markFailed(tasks: readonly Task[], id: string, attempt: number, error: { code: string; message: string }, now: number): Task[] {
  return update(tasks, id, (t) => (t.status === "running" && t.attempt === attempt ? { ...t, status: "failed", speedBps: 0, error, finishedAt: now } : t));
}

/** 命令以 cancelled 返回（运行中被取消），或排队中直接取消。 */
export function markCancelled(tasks: readonly Task[], id: string, now: number): Task[] {
  return update(tasks, id, (t) => (isActiveTask(t) ? { ...t, status: "cancelled", speedBps: 0, finishedAt: now } : t));
}

/** 重试：同一任务回到排队并移到队尾，尝试次数加一。只有失败的任务能重试。 */
export function retryTask(tasks: readonly Task[], id: string): Task[] {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`没有任务 ${id}`);
  if (task.status !== "failed") throw new Error(`任务 ${id} 是 ${task.status}，只有失败的任务能重试`);
  const retried: Task = {
    ...task,
    status: "queued",
    attempt: task.attempt + 1,
    error: null,
    progress: 0,
    bytes: 0,
    totalBytes: null,
    doneBytes: 0,
    speedBps: 0,
    startedAt: null,
    finishedAt: null,
  };
  return [...tasks.filter((t) => t.id !== id), retried];
}

function finishedAtOf(task: Task): number {
  if (task.finishedAt === null) throw new Error(`已结束的任务 ${task.id} 没有结束时刻`);
  return task.finishedAt;
}

/** 已结束的任务只留最近 TASK_HISTORY_LIMIT 条（按结束时刻），超出的最早一条自动丢弃。 */
export function trimHistory(tasks: readonly Task[]): Task[] {
  const finished = tasks.filter(isFinishedTask);
  if (finished.length <= TASK_HISTORY_LIMIT) return [...tasks];
  const keep = new Set(
    [...finished]
      .sort((a, b) => finishedAtOf(b) - finishedAtOf(a))
      .slice(0, TASK_HISTORY_LIMIT)
      .map((t) => t.id),
  );
  return tasks.filter((t) => isActiveTask(t) || keep.has(t.id));
}

export function clearFinished(tasks: readonly Task[]): Task[] {
  return tasks.filter(isActiveTask);
}

/** 上次关闭时还没完成的任务：记为失败，原因「落樱关闭时中断」，可以重试。 */
export function restoreJournal(tasks: readonly Task[], now: number): Task[] {
  const error = { code: TASK_INTERRUPTED_CODE, message: taskFailureReason({ code: TASK_INTERRUPTED_CODE, message: "" }) };
  return tasks.map((t) => (isActiveTask(t) ? { ...t, status: "failed", speedBps: 0, error, finishedAt: now } : t));
}
