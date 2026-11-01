// 下载任务页的纯函数：分组与筛选、行内元信息、剩余时间与用时、吞吐总览、曲线几何、取消前的确认判定。
// 页面组件只负责把这些结果画出来，规则都在这里，便于不挂界面直接测。

import type { IconName } from "../../art/Icon";
import { CONFIRM_COPY, TASK_STATUS_LABEL, TASK_TEXT, taskFailureReason } from "../../copy/flows";
import { formatBytes, formatPlaytime, formatRelative, formatSpeed, percent } from "../../domain/format";
import { MAX_PARALLEL_TASKS } from "../../domain/limits";
import type { Task, TaskKind } from "../../domain/types";
import type { RouteOf, TaskFilter } from "../../state/route";
import { attemptTaskId } from "../../state/tasks";
import { CHART_MIN_CEILING_BPS, CHART_VIEW, ETA_WINDOW_SAMPLES, THROUGHPUT_SAMPLES } from "./constants";
import { TASKS_COPY } from "./copy";

/** 任务类别的线性图标。修复补的是游戏文件，与新建实例同用「游戏本体」的图标。 */
export const KIND_ICON: Readonly<Record<TaskKind, IconName>> = {
  game: "box",
  loader: "layers",
  mod: "mod",
  modpack: "modpack",
  java: "java",
  resourcepack: "resource-pack",
  shader: "shader",
  datapack: "datapack",
  repair: "box",
  world_backup: "world",
  world_restore: "world",
  modpack_export: "modpack",
};

/**
 * 这一类任务运行时是不是在下载。导出整合包是本地打包，备份与恢复存档是本地读写，只是同走一条队列；
 * 修复补的是游戏文件，算下载。逐类写全：以后加类别时由类型逼着定它算不算。
 */
const DOWNLOADS_WHEN_RUNNING: Readonly<Record<TaskKind, boolean>> = {
  game: true,
  loader: true,
  mod: true,
  modpack: true,
  java: true,
  resourcepack: true,
  shader: true,
  datapack: true,
  repair: true,
  world_backup: false,
  world_restore: false,
  modpack_export: false,
};

/** 备份与恢复存档只碰本机文件，断网时重试照样能成；导出要向平台反查 Mod，其余都要下载。 */
const OFFLINE_RETRY_KINDS: ReadonlySet<TaskKind> = new Set(["world_backup", "world_restore"]);

export function retryNeedsNetwork(task: Task): boolean {
  return !OFFLINE_RETRY_KINDS.has(task.kind);
}

export const TASK_FILTERS = ["all", "active", "done", "failed"] as const satisfies readonly TaskFilter[];

// ---------------------------------------------------------------- 路由

/** 路由不带筛选即「全部」：侧栏与快览进页时都不带参数。 */
export function filterOf(route: RouteOf<"tasks">): TaskFilter {
  return route.filter === undefined ? "all" : route.filter;
}

/** 「全部」写回成不带参数的路由，与侧栏进页的路由相同，再点侧栏不会多出一条历史。 */
export function filterRoute(filter: TaskFilter): RouteOf<"tasks"> {
  return filter === "all" ? { page: "tasks" } : { page: "tasks", filter };
}

// ---------------------------------------------------------------- 分组

export interface TaskBuckets {
  /** 运行中与排队中都按队列（数组）顺序：入队追加到末尾、重试移到末尾，数组顺序就是加入队列的先后。 */
  running: Task[];
  queued: Task[];
  /** 已结束的三类各自按结束时刻从新到旧。 */
  done: Task[];
  /** 失败与取消合在一起，对应筛选「失败与取消」。 */
  ended: Task[];
  finished: Task[];
}

function finishedAtOf(task: Task): number {
  if (task.finishedAt === null) throw new Error(`已结束的任务 ${task.id} 没有结束时刻`);
  return task.finishedAt;
}

const newestFirst = (a: Task, b: Task) => finishedAtOf(b) - finishedAtOf(a);

export function bucketTasks(tasks: readonly Task[]): TaskBuckets {
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const done = tasks.filter((t) => t.status === "done").sort(newestFirst);
  const ended = tasks.filter((t) => t.status === "failed" || t.status === "cancelled").sort(newestFirst);
  const finished = [...done, ...ended].sort(newestFirst);
  return { running, queued, done, ended, finished };
}

export function filterCounts(b: TaskBuckets): Readonly<Record<TaskFilter, number>> {
  const active = b.running.length + b.queued.length;
  return { all: active + b.finished.length, active, done: b.done.length, failed: b.ended.length };
}

/**
 * 页头副标题。「下载中」只数下载类；排队的都还没开始，不分类别。
 * 只有本地任务在跑、也没有排队的时候，「0 个下载中，0 个排队」读起来像队列是空的，改说进行中的个数。
 */
export function subtitleOf(b: TaskBuckets): string {
  if (b.running.length + b.queued.length === 0) return TASKS_COPY.subtitleIdle;
  const downloading = b.running.filter((t) => DOWNLOADS_WHEN_RUNNING[t.kind]).length;
  if (downloading === 0 && b.queued.length === 0) return TASKS_COPY.subtitleLocal(b.running.length);
  return TASKS_COPY.subtitleActive(downloading, b.queued.length);
}

export interface TaskGroup {
  key: string;
  /** 只有「全部」分组时才有组标题。 */
  label: string | null;
  tasks: Task[];
}

/** 当前筛选下要画的分组，空组不出现；返回空数组即这个筛选下没有任务。 */
export function taskGroups(b: TaskBuckets, filter: TaskFilter): TaskGroup[] {
  const active = [...b.running, ...b.queued];
  let groups: TaskGroup[];
  switch (filter) {
    case "all":
      groups = [
        { key: "active", label: TASKS_COPY.group.active(active.length), tasks: active },
        { key: "finished", label: TASKS_COPY.group.finished(b.finished.length), tasks: b.finished },
      ];
      break;
    case "active":
      groups = [{ key: "active", label: null, tasks: active }];
      break;
    case "done":
      groups = [{ key: "done", label: null, tasks: b.done }];
      break;
    case "failed":
      groups = [{ key: "failed", label: null, tasks: b.ended }];
      break;
  }
  return groups.filter((g) => g.tasks.length > 0);
}

/** 下载进度快照只改这几个字段。 */
const PROGRESS_FIELDS: ReadonlySet<string> = new Set<keyof Task>(["progress", "bytes", "totalBytes", "doneBytes", "speedBps"]);

function sameApartFromProgress(a: Task, b: Task): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof Task)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => PROGRESS_FIELDS.has(key) || Object.is(a[key], b[key]));
}

/**
 * 两张任务表除了下载进度以外完全相同：任务没有增删、没有换状态、没有重试。页面按它订阅任务表，
 * 每 100 ms 一次的进度只让进度相关的部件（吞吐卡、通道卡、运行中的那一行）各自重渲染，分组、筛选与已结束的行不动。
 * 不认识的字段一律算结构：以后给任务加了字段，宁可多重排一次，也不漏掉变化。
 */
export function sameTaskLayout(a: readonly Task[], b: readonly Task[]): boolean {
  return a.length === b.length && a.every((task, i) => sameApartFromProgress(task, b[i]));
}

/** 三条并行通道各放哪个运行中的任务；空闲的通道为 null。 */
export function laneSlots(running: readonly Task[]): (Task | null)[] {
  if (running.length > MAX_PARALLEL_TASKS) throw new Error(`同时运行的任务有 ${running.length} 个，超过了上限 ${MAX_PARALLEL_TASKS}`);
  return Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => (i < running.length ? running[i] : null));
}

// ---------------------------------------------------------------- 时间

/**
 * 剩余时间：不足 60 秒按 5 秒向上取整（逐秒跳动的个位数没有意义），不足 1 小时按分钟向上取整，更久不再细说。
 * 算不出（速度为 0 带来的无穷）或已经下完时写「即将完成」。
 */
export function etaText(seconds: number): string {
  if (Number.isNaN(seconds)) throw new Error("剩余时间不能是 NaN");
  if (!Number.isFinite(seconds) || seconds <= 0) return TASKS_COPY.eta.soon;
  if (seconds < 60) {
    const rounded = Math.ceil(seconds / 5) * 5;
    if (rounded < 60) return TASKS_COPY.eta.seconds(rounded);
  }
  if (seconds < 3600) return TASKS_COPY.eta.minutes(Math.ceil(seconds / 60));
  return TASKS_COPY.eta.overHour;
}

/** 用时：不足 60 秒写秒（至少 1 秒），否则按游玩时长的写法写分钟与小时。 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`用时必须是非负有限数，收到 ${ms}`);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return TASKS_COPY.took.seconds(Math.max(1, seconds));
  return formatPlaytime(ms / 60_000);
}

// ---------------------------------------------------------------- 吞吐采样

export interface ThroughputSample {
  /** 这一秒所有运行中任务的速度之和。 */
  total: number;
  /** 这一秒各任务的速度，键是这一次尝试的 taskId：重试后的新尝试不沿用上一次的速度。 */
  tasks: Readonly<Record<string, number>>;
}

export function takeSample(running: readonly Task[]): ThroughputSample {
  const tasks: Record<string, number> = {};
  let total = 0;
  for (const t of running) {
    tasks[attemptTaskId(t)] = t.speedBps;
    total += t.speedBps;
  }
  return { total, tasks };
}

/** 追加一个采样，只留最近 THROUGHPUT_SAMPLES 个。 */
export function pushSample(history: readonly ThroughputSample[], sample: ThroughputSample): ThroughputSample[] {
  return [...history, sample].slice(-THROUGHPUT_SAMPLES);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * 估算剩余时间用的速度：最近 ETA_WINDOW_SAMPLES 秒的平均。窗口里还没有这个任务的采样（刚开始），
 * 或平均下来为 0（刚从停顿里恢复），用当前的瞬时速度。
 */
export function etaSpeed(history: readonly ThroughputSample[], task: Task): number {
  const key = attemptTaskId(task);
  const recent = history
    .slice(-ETA_WINDOW_SAMPLES)
    .filter((s) => Object.hasOwn(s.tasks, key))
    .map((s) => s.tasks[key]);
  if (recent.length === 0) return task.speedBps;
  const avg = mean(recent);
  return avg > 0 ? avg : task.speedBps;
}

/** 总览的剩余时间速度：规则同 etaSpeed，对象换成总速度。 */
export function totalEtaSpeed(history: readonly ThroughputSample[], current: number): number {
  const recent = history.slice(-ETA_WINDOW_SAMPLES).map((s) => s.total);
  if (recent.length === 0) return current;
  const avg = mean(recent);
  return avg > 0 ? avg : current;
}

// ---------------------------------------------------------------- 行内元信息

export interface RowMeta {
  left: string;
  right: string;
  /** 左侧是失败原因，用危险色。 */
  danger: boolean;
}

export interface RowMetaContext {
  /** queued 任务在队里的位次（从 1 计）；其余状态为 null。 */
  queuePosition: number | null;
  /** 估算剩余时间用的速度（etaSpeed）。 */
  etaSpeed: number;
  /** 相对时间的参照时刻。 */
  now: number;
}

function sizeOrPending(bytes: number | null): string {
  return bytes === null ? TASKS_COPY.row.sizePending : formatBytes(bytes);
}

function runningMeta(task: Task, speedForEta: number): { left: string; right: string } {
  const total = task.totalBytes;
  const left =
    total === null ? (task.bytes > 0 ? TASKS_COPY.row.transfer(formatBytes(task.bytes), TASKS_COPY.row.sizePending) : TASKS_COPY.row.sizePending) : TASKS_COPY.row.transfer(formatBytes(task.bytes), formatBytes(total));
  if (task.speedBps <= 0) return { left, right: TASKS_COPY.row.waitingData };
  // 总量未知时估不出剩余时间，只报速度
  if (total === null) return { left, right: formatSpeed(task.speedBps) };
  const speed = speedForEta > 0 ? speedForEta : task.speedBps;
  return { left, right: TASKS_COPY.row.speedEta(formatSpeed(task.speedBps), etaText(Math.max(0, total - task.bytes) / speed)) };
}

/**
 * 完成行左侧的「总量 · 用时」。总量是这一次尝试跨批次累计下载的字节（一次安装连跑好几批，最后一批只是其中一段）；
 * 一个字节都没下（文件都已就绪）时不写。用时从这一次尝试开始运行算起，不含排队等待，也不含之前失败的尝试；
 * 较早写入的任务记录没有开始时刻，不写用时，而不是拿加入队列的时刻冒充。
 * 运行期间系统时钟往回调过时结束时刻会早于开始时刻：两个时刻都是真实记下的，只是用时无从得知，同样不写；
 * 任务表会落盘，按契约错误抛出的话下载任务页每次打开都崩，清理已结束任务的按钮也在这一页上。
 */
function doneSummary(task: Task): string {
  const size = task.doneBytes > 0 ? formatBytes(task.doneBytes) : null;
  const finishedAt = finishedAtOf(task);
  const took = task.startedAt === null || finishedAt < task.startedAt ? null : durationText(finishedAt - task.startedAt);
  if (size !== null && took !== null) return TASKS_COPY.row.doneWithSize(size, took);
  if (took !== null) return TASKS_COPY.row.doneNoSize(took);
  if (size !== null) return size;
  return TASK_STATUS_LABEL.done;
}

export function rowMeta(task: Task, ctx: RowMetaContext): RowMeta {
  let meta: RowMeta;
  switch (task.status) {
    case "running":
      meta = { ...runningMeta(task, ctx.etaSpeed), danger: false };
      break;
    case "queued": {
      if (ctx.queuePosition === null) throw new Error(`排队中的任务 ${task.id} 没有队列位次`);
      meta = { left: TASK_TEXT.queuePosition(ctx.queuePosition), right: sizeOrPending(task.totalBytes), danger: false };
      break;
    }
    case "done":
      meta = { left: doneSummary(task), right: formatRelative(finishedAtOf(task), ctx.now), danger: false };
      break;
    case "failed": {
      if (task.error === null) throw new Error(`失败的任务 ${task.id} 没有失败原因`);
      meta = { left: TASKS_COPY.row.failed(taskFailureReason(task.error)), right: formatRelative(finishedAtOf(task), ctx.now), danger: true };
      break;
    }
    case "cancelled":
      meta = { left: TASKS_COPY.row.cancelledAt(percent(task.progress)), right: formatRelative(finishedAtOf(task), ctx.now), danger: false };
      break;
  }
  if (task.attempt >= 2) meta = { ...meta, left: `${meta.left} · ${TASK_TEXT.attempt(task.attempt)}` };
  return meta;
}

// ---------------------------------------------------------------- 吞吐总览

export type OverviewLabel = "running" | "waiting" | "idle";

export interface Overview {
  label: OverviewLabel;
  /** 运行中任务的瞬时速度之和。 */
  speed: number;
  /** 总量已知的活动任务：已下字节之和与总字节之和。总量未知的任务两边都不计，避免进度超过 100%。 */
  downloaded: number;
  total: number;
  /** 0-1；没有总量已知的活动任务时为 null（进度环圆心写「--」，而不是一个没有意义的 0%）。 */
  fraction: number | null;
}

export function overviewOf(b: TaskBuckets): Overview {
  const active = [...b.running, ...b.queued];
  let downloaded = 0;
  let total = 0;
  for (const t of active) {
    if (t.totalBytes === null) continue;
    total += t.totalBytes;
    downloaded += Math.min(t.bytes, t.totalBytes);
  }
  const speed = b.running.reduce((sum, t) => sum + t.speedBps, 0);
  const label: OverviewLabel = b.running.length > 0 ? "running" : active.length > 0 ? "waiting" : "idle";
  return { label, speed, downloaded, total, fraction: total > 0 ? downloaded / total : null };
}

/** 总览副行：剩余字节与剩余时间；没有任何下载流量时写「等待数据」。 */
export function overviewRemaining(o: Overview, speedForEta: number): string {
  const remaining = Math.max(0, o.total - o.downloaded);
  const speed = speedForEta > 0 ? speedForEta : o.speed;
  return TASKS_COPY.flow.remaining(formatBytes(remaining), speed > 0 ? etaText(remaining / speed) : TASKS_COPY.row.waitingData);
}

// ---------------------------------------------------------------- 吞吐曲线

export interface ChartGeometry {
  line: string;
  area: string;
  /** 全部采样为 0：曲线贴底，改为显示「最近 N 秒没有下载流量」。 */
  idle: boolean;
}

/** 最近 THROUGHPUT_SAMPLES 秒的总速度曲线；采样不足时左侧补 0。纵轴上限 = max(最低上限, 样本最大值)。 */
export function chartGeometry(totals: readonly number[]): ChartGeometry {
  const recent = totals.slice(-THROUGHPUT_SAMPLES);
  const padded = [...Array<number>(THROUGHPUT_SAMPLES - recent.length).fill(0), ...recent];
  const ceiling = Math.max(CHART_MIN_CEILING_BPS, ...padded);
  const { width, height, peak } = CHART_VIEW;
  const points = padded.map((v, i) => `${((i / (THROUGHPUT_SAMPLES - 1)) * width).toFixed(2)},${(height - (v / ceiling) * peak).toFixed(2)}`);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
  return { line, area: `${line} L${width},${height} L0,${height} Z`, idle: padded.every((v) => v === 0) };
}

// ---------------------------------------------------------------- 取消前的确认

export interface CancelConfirm {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "danger";
}

/** 取消后会动到实例本体的任务：新建与导入（取消即撤掉实例）、修复（实例停在文件不完整）。 */
const CREATE_COMMANDS = new Set(["install_version", "install_modpack"]);
const REPAIR_COMMAND = "repair_instance";

/** 实例级任务的实例名。实例 id 就是版本目录名，也是显示名。 */
function instanceNameOf(task: Task): string {
  if (task.instanceId === null) throw new Error(`实例级任务 ${task.id} 没有关联实例`);
  return task.instanceId;
}

/**
 * 取消单个任务前要不要确认、确认什么。只有运行中的实例级任务要确认：排队中的取消只是移出队列，
 * Mod、资源、Java 任务取消后只丢弃临时文件，代价都很小。
 */
export function cancelConfirm(task: Task): CancelConfirm | null {
  if (task.status !== "running") return null;
  const tail = { cancelLabel: CONFIRM_COPY.keepDownloading, tone: "danger" } as const;
  if (CREATE_COMMANDS.has(task.spec.command)) return { ...CONFIRM_COPY.cancelCreate(task.title, instanceNameOf(task)), ...tail };
  if (task.spec.command === REPAIR_COMMAND) return { ...CONFIRM_COPY.cancelRepair(task.title, instanceNameOf(task)), ...tail };
  return null;
}

/**
 * 全部取消一律确认。排队中的新建任务被取消后占位实例同样消失，排队中的修复任务同样让实例停在不完整，
 * 所以两类计数都包括排队中的。
 */
export function cancelAllConfirm(active: readonly Task[]): CancelConfirm {
  const creating = active.filter((t) => CREATE_COMMANDS.has(t.spec.command)).length;
  const repairing = active.filter((t) => t.spec.command === REPAIR_COMMAND).length;
  return { ...CONFIRM_COPY.cancelAll(active.length, creating, repairing), cancelLabel: CONFIRM_COPY.keepDownloading, tone: "danger" };
}
