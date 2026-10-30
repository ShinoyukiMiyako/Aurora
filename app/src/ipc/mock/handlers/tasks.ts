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
const cancelled = new Set<string>();

/** 其他领域的 mock 在模拟长任务时用它检查自己是否已被取消。 */
export function isMockTaskCancelled(taskId: string): boolean {
  return cancelled.has(taskId);
}

export const handlers: MockHandlers = {
  cancel_task: (args) => {
    if (typeof args.taskId !== "string") throw new Error("cancel_task 缺少 taskId");
    cancelled.add(args.taskId);
  },
  save_task_journal: (args) => {
    if (!Array.isArray(args.tasks)) throw new Error("save_task_journal 缺少 tasks 数组");
    journal = args.tasks as TaskRecordDto[];
  },
  load_task_journal: () => journal,
};

export function reset(): void {
  journal = seedJournal();
  cancelled.clear();
}
