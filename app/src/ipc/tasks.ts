// 长任务的关联、取消与任务日志，以及后端进度事件 aurora://core-event。
// 安装版本、装 Mod、装 Java、修复、整合包、启动这些长命令都带 taskId 参数；
// 进度事件带 task_id 用来区分并行的任务，不带 task_id 的事件只属于启动会话。

import type { TaskKind, TaskStatus } from "../domain/types";
import { invoke, listen, type UnlistenFn } from "./bridge";
import type { BlockedFileDto } from "./modpack";

export const CORE_EVENT = "aurora://core-event";

/**
 * step：命令作为组合任务的一项调用时，调用方给的「第几项」（从 0 计），后端原样标在这次调用的每条事件上。
 * 组合任务的各项共用一个 task_id、各自从 0 报起，上一项的进度可能晚于下一项开始才送到，单看快照分不清，靠它分开。
 * 单独调用的命令没有这一项。
 */
export type CoreEvent =
  | { kind: "stage"; task_id: string | null; step?: number; message: string }
  | { kind: "warning"; task_id: string | null; step?: number; message: string }
  | {
      kind: "download";
      task_id: string | null;
      step?: number;
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
  /** 以 distribution_blocked 失败时需要手动下载的文件清单；其余失败与较早写入的日志没有这一项。 */
  blocked_files?: readonly BlockedFileDto[];
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
  /** 较早写入的日志没有这一项。 */
  done_bytes?: number;
  speed_bps: number;
  /** 较早写入的日志没有这一项。 */
  started_at?: number | null;
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

/** 读回的任务日志。 */
export interface TaskJournalDto {
  /** 已落盘那份的序号；从未写过或加序号之前写的日志为 0。此后的写入从它之后接着编。 */
  seq: number;
  tasks: TaskRecordDto[];
}

/**
 * 整表写入任务日志（含已结束的最近若干条）。每条的 id 须非空且互不重复，否则整次拒绝、不落盘。
 * seq 是这份的序号，从 1 起单调递增：几次写入并发时到达后端的先后不定，后端只接受比已落盘那份大的，
 * 晚到的旧版本直接丢弃，不报错。
 */
export const saveTaskJournal = (seq: number, tasks: TaskRecordDto[]): Promise<void> =>
  invoke<void>("save_task_journal", { seq, tasks });

/** 读取上次写入的任务日志；从未写过时为 { seq: 0, tasks: [] }，文件损坏或版本不符时以 task_journal_invalid 拒绝。 */
export const loadTaskJournal = (): Promise<TaskJournalDto> => invoke<TaskJournalDto>("load_task_journal");

/** 删掉 `dest` 旁边上次没写完的导出临时文件。只收导出的命名，别的文件不碰；没有残留也算成功。 */
export const discardExportLeftovers = (dest: string): Promise<void> => invoke<void>("discard_export_leftovers", { dest });

export const onCoreEvent = (handler: (event: CoreEvent) => void): Promise<UnlistenFn> =>
  listen<CoreEvent>(CORE_EVENT, handler);
