import { IpcError } from "../../errors";
import type { TaskJournalDto, TaskRecordDto } from "../../tasks";
import type { MockHandlers } from "../types";

const HOUR = 3_600_000;

// 一条已完成的 Java 下载，让下载任务页在浏览器里打开时不是空表。
function seedJournal(): TaskRecordDto[] {
  const now = Date.now();
  return [
    {
      id: "task-seed-1",
      kind: "java",
      title: "下载 Java 25",
      detail: "Eclipse Adoptium 25.0.1 · 自动下载",
      instance_id: null,
      status: "done",
      progress: 1,
      bytes: 52_400_000,
      total_bytes: 52_400_000,
      speed_bps: 0,
      attempt: 1,
      error: null,
      created_at: now - HOUR,
      finished_at: now - HOUR + 60_000,
      spec: { command: "install_java", args: { requiredMajor: 25 } },
    },
  ];
}

/** 记住多少个「取消先于登记到达」的 id，与后端的 EARLY_CANCEL_MEMORY 一致。 */
const EARLY_CANCEL_MEMORY = 64;

// 种子当作加序号之前写下的日志，序号为 0
let journal: TaskJournalDto = { seq: 0, tasks: seedJournal() };
/** 运行中的长任务：这一次登记有没有收到取消。 */
const running = new Map<string, { cancelled: boolean }>();
/**
 * 与后端一样只记「取消时不在运行」的 id（取消先于登记到达），同 id 随后登记就是已取消状态，记下的 id 随即用掉。
 * 取消时正在运行的只作用于那一次登记：它结束后同一个 id 再登记拿到的是全新的状态。
 */
let cancelledEarly: string[] = [];

/**
 * 长任务 mock 在开始时登记自己，与后端 TaskRegistry::register 同样拒绝空 id 与重复 id。
 * 结束（成功、失败或取消）时必须调 endMockTask。
 */
export function beginMockTask(taskId: string): void {
  if (taskId.trim() === "") throw new IpcError("invalid_argument", "task_id 不能为空");
  if (running.has(taskId)) throw new IpcError("task_conflict", `任务 ${taskId} 已在运行`, { task_id: taskId });
  const early = cancelledEarly.includes(taskId);
  if (early) cancelledEarly = cancelledEarly.filter((id) => id !== taskId);
  running.set(taskId, { cancelled: early });
}

export function endMockTask(taskId: string): void {
  running.delete(taskId);
}

/**
 * 长任务 mock 用它检查自己是否已被取消；被取消的长任务应以 IpcError("cancelled") 拒绝。
 * 不在运行的 id 回答它是否作为先到的取消被记着。
 */
export function isMockTaskCancelled(taskId: string): boolean {
  const entry = running.get(taskId);
  return entry === undefined ? cancelledEarly.includes(taskId) : entry.cancelled;
}

function validateJournal(tasks: unknown[]): TaskRecordDto[] {
  const seen = new Set<string>();
  tasks.forEach((task, index) => {
    const id = typeof task === "object" && task !== null ? (task as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || id === "") throw new IpcError("invalid_argument", `任务日志第 ${index} 项缺少字符串 id`);
    if (seen.has(id)) throw new IpcError("invalid_argument", `任务日志里 id ${id} 出现了不止一次`);
    seen.add(id);
  });
  return tasks as TaskRecordDto[];
}

export const handlers: MockHandlers = {
  cancel_task: (args) => {
    if (typeof args.taskId !== "string") throw new Error("cancel_task 缺少 taskId");
    const taskId = args.taskId;
    const entry = running.get(taskId);
    if (entry !== undefined) {
      entry.cancelled = true;
      return true;
    }
    if (!cancelledEarly.includes(taskId)) cancelledEarly = [...cancelledEarly, taskId].slice(-EARLY_CANCEL_MEMORY);
    return false;
  },
  save_task_journal: (args) => {
    const seq = args.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw new Error("save_task_journal 缺少非负整数 seq");
    if (!Array.isArray(args.tasks)) throw new Error("save_task_journal 缺少 tasks 数组");
    if (seq === 0) throw new IpcError("invalid_argument", "任务日志的序号从 1 起，收到 0");
    const tasks = validateJournal(args.tasks);
    // 与后端一样：不比已落盘那份新的是晚到的旧版本，丢弃不报错
    if (seq <= journal.seq) return;
    journal = { seq, tasks };
  },
  load_task_journal: () => journal,
  discard_export_leftovers: () => null,
};

export function reset(): void {
  journal = { seq: 0, tasks: seedJournal() };
  running.clear();
  cancelledEarly = [];
}
