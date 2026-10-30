import { IpcError } from "../../errors";
import type { TaskRecordDto } from "../../tasks";
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

let journal: TaskRecordDto[] = seedJournal();
const running = new Set<string>();
// 与后端一样，取消先于登记到达时也记下 id：同 id 随后登记就是已取消状态。
const cancelled = new Set<string>();

/**
 * 长任务 mock 在开始时登记自己，与后端 TaskRegistry::register 同样拒绝空 id 与重复 id。
 * 结束（成功、失败或取消）时必须调 endMockTask。
 */
export function beginMockTask(taskId: string): void {
  if (taskId.trim() === "") throw new IpcError("invalid_argument", "task_id 不能为空");
  if (running.has(taskId)) throw new IpcError("task_conflict", `任务 ${taskId} 已在运行`, { task_id: taskId });
  running.add(taskId);
}

export function endMockTask(taskId: string): void {
  running.delete(taskId);
}

/** 长任务 mock 用它检查自己是否已被取消；被取消的长任务应以 IpcError("cancelled") 拒绝。 */
export function isMockTaskCancelled(taskId: string): boolean {
  return cancelled.has(taskId);
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
    cancelled.add(args.taskId);
    return running.has(args.taskId);
  },
  save_task_journal: (args) => {
    if (!Array.isArray(args.tasks)) throw new Error("save_task_journal 缺少 tasks 数组");
    journal = validateJournal(args.tasks);
  },
  load_task_journal: () => journal,
};

export function reset(): void {
  journal = seedJournal();
  running.clear();
  cancelled.clear();
}
