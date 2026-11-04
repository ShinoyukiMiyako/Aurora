// 前端领域模型的基础类型：界面与状态层只认这里的形状，DTO（snake_case）在状态层转换后再进来。
// 取值集合写成 as const 数组再派生类型，运行期校验（未知取值即抛错）与类型共用同一份来源。

import type { BlockedFileDto } from "../ipc/modpack";

// ---------------------------------------------------------------- 外观

export const APPEARANCE_MODES = ["day", "night"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const ACCENT_NAMES = ["sakura", "amethyst", "moss"] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** 实例卡面的默认背景：渐变花瓣，或封面方块的材质平铺。 */
export const COVER_STYLES = ["art", "texture"] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

/** 实例自己的卡面背景：follow 跟随外观里的默认，image 为玩家图片。 */
export const COVER_BACKGROUNDS = ["follow", "art", "texture", "image"] as const;
export type CoverBackground = (typeof COVER_BACKGROUNDS)[number];

export interface Appearance {
  mode: AppearanceMode;
  accent: AccentName;
  /** 主页飘落花瓣；减少动画生效时无论这里怎么设都静止。 */
  petals: boolean;
  /** 外观设置里的樱花林全景背景。 */
  panorama: boolean;
  /** 应用内的「减少动画」开关；与系统偏好取或得到生效值。 */
  reduceMotion: boolean;
  /** 实例卡面的默认背景：实例设为跟随时用它。 */
  coverBackground: CoverStyle;
}

// ---------------------------------------------------------------- 资源与账户

export const LOADER_KINDS = ["vanilla", "fabric", "quilt", "forge", "neoforge"] as const;
export type LoaderKind = (typeof LOADER_KINDS)[number];

export type AccountKind = "microsoft" | "offline" | "authlib";
export type ResourceKind = "mod" | "modpack" | "resourcepack" | "shader" | "datapack";
export const PLATFORMS = ["modrinth", "curseforge"] as const;
export type Platform = (typeof PLATFORMS)[number];

// ---------------------------------------------------------------- 启动会话

export type SessionPhase = "preparing" | "downloading" | "launching" | "running" | "stopped" | "failed" | "crashed";
export type StopReason = "cancelled" | "exited" | "killed";

export const FAILURE_CODES = [
  "java_missing",
  "java_pinned_missing",
  "java_too_old",
  "account_relogin",
  "account_refresh_network",
  "account_service_down",
  "account_app_not_approved",
  "account_client_id_missing",
  "files_offline",
  "files_failed",
  "disk_full",
  "version_broken",
  "loader_library_missing",
  "path_unsupported",
  "spawn_failed",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface LogLine {
  /** 前端收到这一行的时刻（毫秒时间戳）。 */
  at: number;
  level: "info" | "warn" | "error";
  /** game：游戏进程输出；launcher：启动阶段与告警。 */
  source: "game" | "launcher";
  text: string;
}

export interface SessionDownload {
  done: number;
  total: number | null;
  bytes: number;
  totalBytes: number | null;
  speedBps: number;
}

export interface Session {
  instanceId: string;
  phase: SessionPhase;
  /** 启动全程的总进度 0-1，单调不减；running 之后恒为 1。 */
  progress: number;
  /** 当前阶段下标，对应八阶段表。 */
  stageIndex: number;
  startedAt: number;
  runningSince: number | null;
  phaseSince: number;
  /** 内存环形缓冲；完整日志在后端文件里。 */
  logs: LogLine[];
  download: SessionDownload | null;
  stopReason: StopReason | null;
  failure: { code: FailureCode; params: Record<string, string | number> } | null;
}

// ---------------------------------------------------------------- 下载任务

/**
 * world_backup：备份与导出存档（都是打包）；world_restore：用备份恢复存档。两者都不算安装；后端在任务期间把实例记为
 * backing_up，只与 Mod 改动、被当作基底兼容，启动、改名、删除都要等它结束。
 */
export const TASK_KINDS = ["game", "loader", "mod", "modpack", "java", "resourcepack", "shader", "datapack", "repair", "world_backup", "world_restore", "modpack_export"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 重试与重启后恢复所需的完整入参：重新调用 command，参数为 args 加上这一次调用专用的 taskId。
 * 每次尝试都要换新的 taskId：后端会记住「取消时不在运行」的 id，同 id 再登记会直接是已取消状态。
 */
export interface TaskSpec {
  command: string;
  args: Record<string, unknown>;
}

/** 新建、补全实例的各步，取值与后端 InstallPhase::key 一一对应。 */
export const INSTALL_PHASES = [
  "metadata",
  "loader_profile",
  "libraries",
  "assets",
  "natives",
  "java",
  "loader_installer",
  "loader_libraries",
  "loader_processors",
  "verify",
  "template",
] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export interface TaskPhase {
  /** 这次尝试的整份步骤表，开工时由后端排定、全程不变。 */
  plan: readonly InstallPhase[];
  /** 当前一步在 plan 里的下标。 */
  index: number;
  /** 这一步认下的那批下载；还没认下为 null。上一步晚到的收尾快照不会被认下。 */
  batch: { total: number; totalBytes: number | null } | null;
}

/** 任务失败记录：错误码与后端原文；以 distribution_blocked 失败时另带需要手动下载的文件清单，较早的日志里没有它。 */
export interface TaskError {
  code: string;
  message: string;
  blocked_files?: readonly BlockedFileDto[];
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  instanceId: string | null;
  status: TaskStatus;
  /** 0-1。分步任务是这一次尝试的整体进度，只进不退；其余任务是当前这一批的进度。 */
  progress: number;
  /** 当前这一批下载已下的字节；一次安装连跑好几批，每批从 0 重新计。 */
  bytes: number;
  totalBytes: number | null;
  /** 这一次尝试累计的有效字节，跨批次累加。跳过的完整文件也算在内，不代表下载了这么多；本地任务完成后的「总量」用它。 */
  doneBytes: number;
  /** 这一次尝试网络上实际读到的字节，跨批次累加，含重传：下载类任务完成后报的量。较早写入的任务记录没有这一项，为 null。 */
  transferredBytes: number | null;
  /** 当前这一批迄今读到的网络字节，只用来算下一条快照又传了多少，不落盘；组合任务的这个数按项记在进度游标里。 */
  batchTransferred: number;
  /** 当前这一批的文件数：有文件没声明大小时 totalBytes 是 null，前后两批只能靠它区分，不落盘；组合任务不用它，恒为 0。 */
  batchFiles: number;
  /** 新建、补全实例这类分步任务当前在哪一步；别的任务或还没报第一步时为 null。不落盘：读回的任务都已结束。 */
  phase: TaskPhase | null;
  speedBps: number;
  /** 这一次尝试开始运行的时刻；排队中、还没开始过为 null。「用时」是 finishedAt 减去它，不含排队等待。 */
  startedAt: number | null;
  /** 第几次尝试，从 1 计。 */
  attempt: number;
  error: TaskError | null;
  createdAt: number;
  finishedAt: number | null;
  spec: TaskSpec;
}

// ---------------------------------------------------------------- 实例忙碌

/**
 * 后端实例锁表里一个实例可能被占着做的事（instance_busy 的 detail.activity，实例列表的 activity 同一套取值）。
 * inherited：别的实例正以它为基底（那个实例启动到游戏退出、补全、导入整合包期间），它的启动、删除、改名、补全被拒。
 * backing_up：备份、恢复或导出存档（含游戏退出后的自动备份），只与 Mod 改动、被当作基底兼容。
 */
export const BUSY_ACTIVITIES = ["installing", "repairing", "renaming", "deleting", "launching", "running", "modifying", "inherited", "backing_up"] as const;
export type BusyActivity = (typeof BUSY_ACTIVITIES)[number];

/** 基底做着这些事时容不下基底占用：自己在启动、运行，或目录正被挪走、重写。改动、备份与别的实例的基底占用都和它兼容。 */
export const BASE_BLOCKING_ACTIVITIES = ["installing", "repairing", "renaming", "deleting", "launching", "running"] as const;
export type BaseBlockingActivity = (typeof BASE_BLOCKING_ACTIVITIES)[number];

/** instance_busy 拒绝的原因：被占着的实例与它在做的事；inherited 时 usedBy 是正以它为基底的实例，其余为 null。 */
export interface InstanceBusy {
  id: string;
  activity: BusyActivity;
  usedBy: string | null;
}
