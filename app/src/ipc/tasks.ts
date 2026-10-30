// 长任务的关联、取消与任务日志，以及后端进度事件 aurora://core-event。
// 安装版本、装 Mod、装 Java、修复、整合包、启动这些长命令都带 taskId 参数；
// 进度事件带 task_id 用来区分并行的任务，不带 task_id 的事件只属于启动会话。

import type { TaskKind, TaskStatus } from "../domain/types";
import { invoke, listen, type UnlistenFn } from "./bridge";

export const CORE_EVENT = "aurora://core-event";

export type CoreEvent =
  | { kind: "stage"; task_id: string | null; message: string }
  | { kind: "warning"; task_id: string | null; message: string }
  | {
      kind: "download";
      task_id: string | null;
      /** 文件总数。 */
      total: number;
      /** 已完成文件数。 */
      finished: number;
      /** 已下载字节。 */
      bytes: number;
      /** 总字节；清单里拿不到大小时为 null。 */
      total_bytes: number | null;
      /** 当前速度，字节每秒。 */
      speed: number;
    };

export interface TaskErrorDto {
  code: string;
  message: string;
}

/** 重新执行该任务所需的命令与参数（不含 taskId）。 */
export interface TaskSpecDto {
  command: string;
  args: Record<string, unknown>;
}

/** 任务日志里的一条记录；时间均为毫秒时间戳。 */
export interface TaskRecordDto {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  instance_id: string | null;
  status: TaskStatus;
  progress: number;
  bytes: number;
  total_bytes: number | null;
  speed_bps: number;
  attempt: number;
  error: TaskErrorDto | null;
  created_at: number;
  finished_at: number | null;
  spec: TaskSpecDto;
}

/** 取消进行中的任务；对应命令随后以 { code: "cancelled" } 返回。 */
export const cancelTask = (taskId: string): Promise<void> => invoke<void>("cancel_task", { taskId });

/** 整表写入任务日志（含已结束的最近若干条）。 */
export const saveTaskJournal = (tasks: TaskRecordDto[]): Promise<void> =>
  invoke<void>("save_task_journal", { tasks });

/** 读取上次写入的任务日志；从未写过时为空数组。 */
export const loadTaskJournal = (): Promise<TaskRecordDto[]> => invoke<TaskRecordDto[]>("load_task_journal");

export const onCoreEvent = (handler: (event: CoreEvent) => void): Promise<UnlistenFn> =>
  listen<CoreEvent>(CORE_EVENT, handler);
