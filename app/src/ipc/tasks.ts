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
      /** 本批文件数。一次安装会连跑多批（版本 JSON、库、资源），每批 finished 都从 0 重新计起。 */
      total: number;
      /** 本批已结束文件数（成功与最终失败都计入）。 */
      finished: number;
      /** 本批有效字节：已就绪的字节，不含重传，失败的文件退回 0；声明大小与实际不符时仍可能越过 total_bytes，画进度时封顶到 1。 */
      bytes: number;
      /** 本批声明大小之和；有任一文件大小未知时为 null。 */
      total_bytes: number | null;
      /** 瞬时速度，字节每秒。 */
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

/**
 * 取消任务，返回它此刻是否在运行。不在运行（已结束，或取消先于命令登记到达）不是错误：
 * 后端会记住这个 id，同 id 随后登记时直接拿到已取消状态，所以每次调用长命令（含重试）都要用新 id。
 * 在运行的命令在 1000 ms 内以 { code: "cancelled" } 拒绝。
 */
export const cancelTask = (taskId: string): Promise<boolean> => invoke<boolean>("cancel_task", { taskId });

/** 整表写入任务日志（含已结束的最近若干条）。每条的 id 须非空且互不重复，否则整次拒绝、不落盘。 */
export const saveTaskJournal = (tasks: TaskRecordDto[]): Promise<void> =>
  invoke<void>("save_task_journal", { tasks });

/** 读取上次写入的任务日志；从未写过时为空数组，文件损坏或版本不符时以 task_journal_invalid 拒绝。 */
export const loadTaskJournal = (): Promise<TaskRecordDto[]> => invoke<TaskRecordDto[]>("load_task_journal");

export const onCoreEvent = (handler: (event: CoreEvent) => void): Promise<UnlistenFn> =>
  listen<CoreEvent>(CORE_EVENT, handler);
