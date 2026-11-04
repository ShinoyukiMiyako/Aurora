// 下载队列的纯函数：入队、调度、进度、结局、重试、历史裁剪与任务日志恢复。真正发命令的是状态容器。
//
// 队列顺序就是数组顺序：入队追加到末尾，重试移到末尾，调度永远取最靠前的 queued，因此「先到先下」与
// 「重试排到队尾」都不需要改写 createdAt。每次尝试的命令 taskId 是「任务 id + 尝试次数」：后端会记住
// 「取消时不在运行」的 id，同 id 再登记会直接是已取消状态，重试必须换新 id。

import { MOVE_INTERRUPTED_CODE, TASK_INTERRUPTED_CODE, taskFailureReason } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { MAX_PARALLEL_TASKS, TASK_HISTORY_LIMIT } from "../domain/limits";
import type { InstallPhase, Task, TaskKind, TaskPhase, TaskSpec } from "../domain/types";

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
 * 任务进度条（进度环、百分比文字）的平滑标识：同一次尝试的同一批下载内只进不退；换了批次（总字节或文件数变了）或换了尝试
 * 直接跳到新值，否则新批次从 0 重新计起时，进度会停在上一批的最大值不动。文件数不能省：Fabric 的库没声明大小，
 * 版本 JSON 与本体加库两批的总字节都是未知。分步任务的进度是整次尝试的，本身只进不退，整次尝试用同一个标识，
 * 换批次时不跳。凡是画任务进度的地方都用它。
 */
export function progressTrack(task: Task): string {
  if (task.phase !== null) return `${attemptTaskId(task)}:phased`;
  return `${attemptTaskId(task)}:${task.totalBytes === null ? "count" : task.totalBytes}:${task.batchFiles}`;
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

/**
 * 一个实例（不分大小写，与后端的锁键一致）上活动中的 Mod 更新任务正在换的文件名，单个与组合任务都算；组合任务跑完之前
 * 它入队时的几项都在内。去重键分单个与组合两种、互不相撞，所以「全部更新」要靠这份名单剔掉已经在换的文件，
 * 否则两个任务会同时换同一个文件和卷宗。
 */
export function modFilesBeingUpdated(tasks: readonly Task[], instanceId: string): Set<string> {
  const key = instanceId.toLowerCase();
  const files = new Set<string>();
  const fileNameOf = (command: string, value: unknown): string => {
    if (typeof value !== "string") throw new Error(`${command} 任务的 fileName 不是字符串：${String(value)}`);
    return value;
  };
  for (const task of tasks) {
    if (!isActiveTask(task) || task.instanceId === null || task.instanceId.toLowerCase() !== key) continue;
    const { command, args } = task.spec;
    if (command === "update_mod") {
      files.add(fileNameOf(command, args.fileName));
    } else if (command === "update_mods") {
      if (!Array.isArray(args.items)) throw new Error("update_mods 任务缺少 items");
      for (const item of args.items as unknown[]) {
        if (typeof item !== "object" || item === null || !("fileName" in item)) throw new Error("update_mods 任务的一项缺少 fileName");
        files.add(fileNameOf(command, item.fileName));
      }
    }
  }
  return files;
}

export function newTask(draft: TaskDraft, now: number): Task {
  return {
    ...draft,
    status: "queued",
    progress: 0,
    bytes: 0,
    totalBytes: null,
    doneBytes: 0,
    transferredBytes: 0,
    batchTransferred: 0,
    batchFiles: 0,
    phase: null,
    speedBps: 0,
    startedAt: null,
    attempt: 1,
    error: null,
    createdAt: now,
    finishedAt: null,
  };
}

/**
 * 这一类任务运行时是不是在下载。导出整合包是本地打包，备份与恢复存档、移到别的游戏目录是本地读写，只是同走一条队列；
 * 修复补的是游戏文件，算下载。逐类写全：以后加类别时由类型逼着定它算不算。
 */
export const DOWNLOADS_WHEN_RUNNING: Readonly<Record<TaskKind, boolean>> = {
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
  instance_move: false,
};

/** 写整个实例目录的命令（新建、导入、补全）：期间实例算「安装中」，后端的实例锁里它与这个实例上的任何别的事都互斥。 */
export const INSTANCE_TASK_COMMANDS: ReadonlySet<string> = new Set(["install_version", "install_modpack", "repair_instance"]);

/** 备份、导出与恢复存档的任务命令；它们都带着 id（实例）与 world（存档文件夹名）两个参数。 */
export const WORLD_TASK_COMMANDS: ReadonlySet<string> = new Set(["backup_world", "export_world", "restore_world_backup"]);

/**
 * 把实例移到别的游戏目录的任务命令，带着 id（实例）、source（发起时实例所在的游戏目录）与 target（目标游戏目录）三个参数。
 * 后端记为 moving，与这个实例上的一切互斥；执行时当前游戏目录已不是 source 就拒绝。
 */
export const MOVE_TASK_COMMAND = "move_instance";

/**
 * 共用一份存档的实例（不隔离）的锁键。隔离结果读不出来的（null）不算：拿不准时不排，撞上了后端照样拒绝，
 * 按 instance_busy 失败、可以重试。
 */
export function sharedSavesKeys(instances: readonly Pick<InstanceSummary, "id" | "isolated">[]): Set<string> {
  return new Set(instances.filter((inst) => inst.isolated === false).map((inst) => inst.id.toLowerCase()));
}

/**
 * a 与 b 在抢这份存档：存档任务撞上导出整合包（后端只拒勾了存档的导出，这里不拆开导出参数，一律排开）或装数据包，
 * 导出整合包撞上装数据包。两个数据包各写各的，不算。
 */
function savesConflict(a: Task, b: Task): boolean {
  const dataPack = b.spec.command === "install_resource" && b.spec.args.resourceType === "data_pack";
  return (dataPack && (WORLD_TASK_COMMANDS.has(a.spec.command) || a.spec.command === "export_modpack")) || (WORLD_TASK_COMMANDS.has(a.spec.command) && b.spec.command === "export_modpack");
}

/**
 * 两个任务后端不让同时进行。挂在同一实例（不分大小写，与后端的锁键一致）上时：至少一个要写整个目录或把它移走；或都是存档任务
 * （backing_up 彼此互斥）；或在抢存档（savesConflict）。
 * 挂在共用存档的两个实例上时只有最后一种：实例锁只管各自的实例，后端另外看共用存档的实例有没有在备份、恢复、读写存档。
 */
function excludes(a: Task, b: Task, sharedSaves: ReadonlySet<string>): boolean {
  if (a.instanceId === null || b.instanceId === null) return false;
  const worldA = WORLD_TASK_COMMANDS.has(a.spec.command);
  const worldB = WORLD_TASK_COMMANDS.has(b.spec.command);
  const saves = savesConflict(a, b) || savesConflict(b, a);
  const keyA = a.instanceId.toLowerCase();
  const keyB = b.instanceId.toLowerCase();
  if (keyA !== keyB) return saves && sharedSaves.has(keyA) && sharedSaves.has(keyB);
  if (INSTANCE_TASK_COMMANDS.has(a.spec.command) || INSTANCE_TASK_COMMANDS.has(b.spec.command)) return true;
  if (a.spec.command === MOVE_TASK_COMMAND || b.spec.command === MOVE_TASK_COMMAND) return true;
  return (worldA && worldB) || saves;
}

/**
 * 有空位时该开始的任务（按队列顺序），已在运行的不算。与运行中的、或排在它前面的任务互斥的留在队里：
 * 一起开始的话后到的那个必然以 instance_busy 失败（例如断网恢复后「全部重试」同时拉起同一实例的补全与装 Mod）。
 * 排在前面、自己也还在等的也算，先到的先做，后来的装 Mod 不绕过等着的补全。sharedSaves 是共用存档的实例
 * （见 sharedSavesKeys），调度时现取：实例的隔离随时能改，从任务日志恢复的任务也没有入队时的实例列表。
 */
export function tasksToStart(tasks: readonly Task[], sharedSaves: ReadonlySet<string>): Task[] {
  const free = MAX_PARALLEL_TASKS - tasks.filter((t) => t.status === "running").length;
  if (free <= 0) return [];
  const ahead = tasks.filter((t) => t.status === "running");
  const start: Task[] = [];
  for (const task of tasks) {
    if (start.length === free) break;
    if (task.status !== "queued") continue;
    const blocked = ahead.some((other) => excludes(task, other, sharedSaves));
    ahead.push(task);
    if (!blocked) start.push(task);
  }
  return start;
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
    t.status === "queued" ? { ...t, status: "running", progress: 0, bytes: 0, totalBytes: null, doneBytes: 0, transferredBytes: 0, batchTransferred: 0, batchFiles: 0, phase: null, speedBps: 0, startedAt: now } : t,
  );
}

/** 后端推来的一批下载的进度快照。 */
export interface DownloadSnapshot {
  total: number;
  finished: number;
  bytes: number;
  totalBytes: number | null;
  transferred: number;
  speed: number;
}

/** 这一批完成了多少：总字节已知按字节，否则按文件数。 */
function snapshotFraction(event: DownloadSnapshot): number {
  if (event.totalBytes !== null && event.totalBytes > 0) return Math.min(1, event.bytes / event.totalBytes);
  return event.total > 0 ? event.finished / event.total : 0;
}

/**
 * 这条快照比上一条多传了多少。传输字节在一批内只增不减，判同一批不看有效字节：失败的文件退回时有效字节变少，
 * 那还是同一批，按新批次算会把这一批已传的再算一遍。
 */
function transferredSince(mark: { totalBytes: number | null; transferred: number }, event: DownloadSnapshot): number {
  return event.totalBytes === mark.totalBytes && event.transferred >= mark.transferred ? event.transferred - mark.transferred : event.transferred;
}

/** 运行中的任务都从 0 算起；只有读回的旧记录没有这个数，它们已经结束，重试时也从 0 开始。 */
function transferredAfter(task: Task, added: number): number {
  if (task.transferredBytes === null) throw new Error(`运行中的任务 ${task.id} 没有传输量`);
  return task.transferredBytes + added;
}

/**
 * 一批下载的进度快照。一次安装连跑好几批，每批从 0 重新计。分步任务按步折成整体进度，只进不退（见 phaseBatch）；
 * 其余任务按当前批次如实显示，批次内只进不退，新批次（已下字节变少，或批次大小、文件数变了）从头开始。
 * 累计字节跨批次往上加，分步任务不算进当前一步的快照也照样记账。
 */
export function applyTaskDownload(tasks: readonly Task[], attemptId: string, event: DownloadSnapshot): Task[] {
  return tasks.map((t) => {
    if (t.status !== "running" || attemptTaskId(t) !== attemptId) return t;
    const fraction = snapshotFraction(event);
    const sameBatch = event.totalBytes === t.totalBytes && event.total === t.batchFiles && event.bytes >= t.bytes;
    const counted: Task = {
      ...t,
      bytes: event.bytes,
      totalBytes: event.totalBytes,
      doneBytes: t.doneBytes + (sameBatch ? event.bytes - t.bytes : event.bytes),
      transferredBytes: transferredAfter(t, transferredSince({ totalBytes: t.totalBytes, transferred: t.batchTransferred }, event)),
      batchTransferred: event.transferred,
      batchFiles: event.total,
      speedBps: event.speed,
    };
    if (t.phase === null) return { ...counted, progress: sameBatch ? Math.max(t.progress, fraction) : fraction };
    const phase = phaseBatch(t.phase, event);
    return phase === null ? counted : { ...counted, phase, progress: Math.max(t.progress, phaseProgress(phase, fraction)) };
  });
}

// ---------------------------------------------------------------- 分步任务的进度

/** 各步在整体进度条里占多宽，按常见耗时排；只决定进度条走得匀不匀，「第几步」不看它。 */
export const PHASE_WEIGHT: Readonly<Record<InstallPhase, number>> = {
  metadata: 1,
  loader_profile: 1,
  libraries: 7,
  assets: 11,
  natives: 1,
  java: 4,
  loader_installer: 1,
  loader_libraries: 3,
  loader_processors: 6,
  verify: 2,
  template: 1,
  move_dependencies: 2,
  move_copy: 6,
  move_verify: 3,
  move_commit: 1,
};

function phaseProgress(phase: TaskPhase, fraction: number): number {
  const weights = phase.plan.map((key) => PHASE_WEIGHT[key]);
  const whole = weights.reduce((sum, w) => sum + w, 0);
  const before = weights.slice(0, phase.index).reduce((sum, w) => sum + w, 0);
  return (before + weights[phase.index] * fraction) / whole;
}

/** 进入下一步：整体进度推到这一步的起点。步骤表中途变了、越界或没往前走是后端的契约错误，直接报错。 */
export function applyTaskPhase(tasks: readonly Task[], attemptId: string, plan: readonly InstallPhase[], index: number): Task[] {
  return tasks.map((t) => {
    if (t.status !== "running" || attemptTaskId(t) !== attemptId) return t;
    if (!Number.isInteger(index) || index < 0 || index >= plan.length) throw new Error(`任务 ${t.id} 的步骤表只有 ${plan.length} 步，收到了第 ${index} 步`);
    if (t.phase !== null && t.phase.plan.join() !== plan.join()) throw new Error(`任务 ${t.id} 的步骤表中途变了：${t.phase.plan.join()} -> ${plan.join()}`);
    if (t.phase !== null && index <= t.phase.index) throw new Error(`任务 ${t.id} 已在第 ${t.phase.index} 步，又收到了第 ${index} 步`);
    const phase: TaskPhase = { plan, index, batch: null };
    return { ...t, phase, progress: Math.max(t.progress, phaseProgress(phase, 0)) };
  });
}

/**
 * 这条快照算不算进当前这一步，算的话返回认下它那批之后的步骤，不算为 null。后端只在上一批返回之后才报下一步，
 * 上一批晚到的快照都已下完：已下完、又不是这一步认下的那批，就是上一步的，不算。
 * 一出现就已下完的批次（文件全都现成）同样不算，它那一步的份额在下一步开始时一并补上。
 */
function phaseBatch(phase: TaskPhase, event: DownloadSnapshot): TaskPhase | null {
  if (phase.batch !== null && phase.batch.total === event.total && phase.batch.totalBytes === event.totalBytes) return phase;
  if (event.finished >= event.total) return null;
  return { ...phase, batch: { total: event.total, totalBytes: event.totalBytes } };
}

// ---------------------------------------------------------------- 组合任务的进度

/** 一批下载的标识：批次总量相同、已下字节没有变少即同一批。 */
interface BatchMark {
  bytes: number;
  totalBytes: number | null;
  transferred: number;
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
 *
 * 每条进度带着它属于第几项（core-event 的 step，调用每一项时给出）。进度事件与命令的返回走不同的通道，上一项的最后几条
 * 可能在下一项已经开始、甚至已经报过进度之后才到；两项声明大小相同或都未知时，单看快照分不清是谁的。所以批次与字节都按项
 * 分开记：晚到的进度只续它自己那一项的批次、补上那一项的字节，不动整体进度——那一项的份额在它做完时已经推满。
 */
export interface CompositeProgress {
  /** 每项的权重：声明大小都已知时为字节数，否则每项为 1。 */
  readonly weights: readonly number[];
  /** 声明大小都已知时为它们的和，作为任务的总量；按项数折算时为 null。 */
  readonly totalBytes: number | null;
  /** 正在进行的那一项；等于项数时已全部做完。 */
  readonly index: number;
  /** 每一项最近一批下载的标识；那一项还没报过进度时为 null。 */
  readonly batches: readonly (BatchMark | null)[];
  /** 每一项实际下载的字节（跨批次累计，晚到的也算上）。 */
  readonly itemBytes: readonly number[];
}

export function compositeProgress(sizes: readonly (number | null)[]): CompositeProgress {
  const known = sizes.filter((size): size is number => size !== null);
  const sum = known.reduce((total, size) => total + size, 0);
  const bySize = known.length === sizes.length && sum > 0;
  return {
    weights: bySize ? known : sizes.map(() => 1),
    totalBytes: bySize ? sum : null,
    index: 0,
    batches: sizes.map(() => null),
    itemBytes: sizes.map(() => 0),
  };
}

function replaced<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, i) => (i === index ? value : item));
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

/**
 * 组合任务第 step 项的一条下载进度。不属于这一次尝试（或这一次尝试已经落定）时返回 null，表示不采纳。
 * step 早于当前项是晚到的进度：只补那一项的字节，整体进度与速度不动。step 越过当前项或越界说明调用方的序号给错了，直接报错。
 */
export function applyCompositeDownload(
  tasks: readonly Task[],
  attemptId: string,
  cursor: CompositeProgress,
  step: number,
  event: DownloadSnapshot,
): { tasks: Task[]; cursor: CompositeProgress } | null {
  const task = runningAttempt(tasks, attemptId);
  if (task === undefined) return null;
  if (!Number.isInteger(step) || step < 0 || step >= cursor.weights.length) {
    throw new Error(`组合任务 ${attemptId} 只有 ${cursor.weights.length} 项，收到了第 ${step} 项的进度`);
  }
  if (step > cursor.index) throw new Error(`组合任务 ${attemptId} 还在第 ${cursor.index} 项，收到了第 ${step} 项的进度`);
  const mark = cursor.batches[step];
  const added = mark !== null && continues(mark, event) ? event.bytes - mark.bytes : event.bytes;
  const itemBytes = replaced(cursor.itemBytes, step, cursor.itemBytes[step] + added);
  const next: CompositeProgress = { ...cursor, batches: replaced(cursor.batches, step, { bytes: event.bytes, totalBytes: event.totalBytes, transferred: event.transferred }), itemBytes };
  const doneBytes = task.doneBytes + added;
  const transferredBytes = transferredAfter(task, mark === null ? event.transferred : transferredSince(mark, event));
  if (step < cursor.index) {
    const late = { ...withCompositeProgress(task, cursor, task.progress, doneBytes), transferredBytes };
    return { tasks: tasks.map((t) => (t === task ? late : t)), cursor: next };
  }
  const whole = weightBefore(cursor, cursor.weights.length);
  const before = weightBefore(cursor, step);
  const fraction =
    cursor.totalBytes === null
      ? (before + cursor.weights[step] * snapshotFraction(event)) / whole
      : Math.min(1, (before + itemBytes[step]) / whole);
  const current: Task = { ...withCompositeProgress(task, cursor, fraction, doneBytes), transferredBytes, speedBps: event.speed };
  return { tasks: tasks.map((t) => (t === task ? current : t)), cursor: next };
}

/** 组合任务的当前项做完：整体进度推到这一项的末尾，游标移到下一项。 */
export function completeCompositeStep(tasks: readonly Task[], attemptId: string, cursor: CompositeProgress): { tasks: Task[]; cursor: CompositeProgress } {
  const index = cursor.index + 1;
  if (index > cursor.weights.length) throw new Error(`组合任务 ${attemptId} 只有 ${cursor.weights.length} 项，不能再往下走`);
  const next: CompositeProgress = { ...cursor, index };
  const task = runningAttempt(tasks, attemptId);
  if (task === undefined) return { tasks: [...tasks], cursor: next };
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

/** 失败里带着手动下载清单的任务：文件没到手，原样重跑只会再失败一次，不进通知的重试与「全部重试」，要走清单。 */
export function awaitsManualFiles(task: Task): boolean {
  return task.error !== null && task.error.blocked_files !== undefined;
}

/**
 * 上次关闭时正在跑的移动：后端在这次打开时已按移动日志收尾，实例要么已在目标里、要么还在原处，结局前端不知道。
 * 照原参数重跑要么撞上「已不在这里」，要么替玩家又移一次，所以不能重试，任务行与「全部重试」都跳过它。
 */
export function settledOnRestart(task: Task): boolean {
  return task.error !== null && task.error.code === MOVE_INTERRUPTED_CODE;
}

/**
 * 「全部重试」与断网恢复的批量重试收不收这个任务。要走手动下载清单的不收（见 awaitsManualFiles）。移动一律不收：它不需要
 * 网络，是玩家逐个确认过的大动作，批量里没人看着它从哪移到哪；发起之后可能已切换了游戏目录，单条重试由玩家自己点，
 * 源目录对不上时后端以 source_changed 拒绝。
 */
export function batchRetryable(task: Task): boolean {
  return task.status === "failed" && !awaitsManualFiles(task) && task.spec.command !== MOVE_TASK_COMMAND;
}

/** 重试：同一任务回到排队并移到队尾，尝试次数加一。只有失败的任务能重试，重启后已由后端收尾的移动不算。 */
export function retryTask(tasks: readonly Task[], id: string): Task[] {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`没有任务 ${id}`);
  if (task.status !== "failed") throw new Error(`任务 ${id} 是 ${task.status}，只有失败的任务能重试`);
  if (settledOnRestart(task)) throw new Error(`任务 ${id} 是关闭时中断的移动，已在打开时收尾，不能重试`);
  const retried: Task = {
    ...task,
    status: "queued",
    attempt: task.attempt + 1,
    error: null,
    progress: 0,
    bytes: 0,
    totalBytes: null,
    doneBytes: 0,
    transferredBytes: 0,
    batchTransferred: 0,
    batchFiles: 0,
    phase: null,
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

/**
 * 补全成功后，这个实例失败的新建与补全都没有要重试的了：实例已经好了，留着的话任务页一直报失败，新建那行点重试还会撞名。
 */
export function dropSuperseded(tasks: readonly Task[], instanceId: string): Task[] {
  const key = instanceId.toLowerCase();
  return tasks.filter((t) => !(t.status === "failed" && t.instanceId !== null && t.instanceId.toLowerCase() === key && (t.spec.command === "install_version" || t.spec.command === "repair_instance")));
}

export function clearFinished(tasks: readonly Task[]): Task[] {
  return tasks.filter(isActiveTask);
}

/** 写到玩家选的目录里的导出任务的落点；别的任务、或记录里读不出落点时为 null。 */
export function exportDestination(spec: TaskSpec): string | null {
  const { command, args } = spec;
  const dest = command === "export_world" ? args.dest : command === "export_modpack" && typeof args.options === "object" && args.options !== null ? (args.options as Record<string, unknown>).destination : null;
  return typeof dest === "string" ? dest : null;
}

/**
 * 上次关闭时还没完成的任务：记为失败，原因「落樱关闭时中断」，可以重试。正在跑的移动例外：后端打开时自己按移动日志收尾，
 * 记成不能重试的另一个码（见 settledOnRestart）；还在排队的移动没开过工，实例原样在原处，照常可以重试。
 */
export function restoreJournal(tasks: readonly Task[], now: number): Task[] {
  const interrupted = (code: string) => ({ code, message: taskFailureReason({ code, message: "" }) });
  const error = interrupted(TASK_INTERRUPTED_CODE);
  const moveError = interrupted(MOVE_INTERRUPTED_CODE);
  return tasks.map((t) => (isActiveTask(t) ? { ...t, status: "failed", speedBps: 0, error: t.status === "running" && t.spec.command === MOVE_TASK_COMMAND ? moveError : error, finishedAt: now } : t));
}
