// 前端领域模型的基础类型：界面与状态层只认这里的形状，DTO（snake_case）在状态层转换后再进来。
// 取值集合写成 as const 数组再派生类型，运行期校验（未知取值即抛错）与类型共用同一份来源。

// ---------------------------------------------------------------- 外观

export const APPEARANCE_MODES = ["day", "night"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const ACCENT_NAMES = ["sakura", "amethyst", "moss"] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

export interface Appearance {
  mode: AppearanceMode;
  accent: AccentName;
  /** 主页飘落花瓣；减少动画生效时无论这里怎么设都静止。 */
  petals: boolean;
  /** 外观设置里的樱花林全景背景。 */
  panorama: boolean;
  /** 应用内的「减少动画」开关；与系统偏好取或得到生效值。 */
  reduceMotion: boolean;
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
  "files_offline",
  "files_failed",
  "disk_full",
  "version_broken",
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

/** world_backup：备份与导出存档（都是打包）；world_restore：用备份恢复存档。两者都不算安装，对实例只算改动中。 */
export const TASK_KINDS = ["game", "loader", "mod", "modpack", "java", "resourcepack", "shader", "datapack", "repair", "world_backup", "world_restore"] as const;
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

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  instanceId: string | null;
  status: TaskStatus;
  /** 0-1。 */
  progress: number;
  /** 当前这一批下载已下的字节；一次安装连跑好几批，每批从 0 重新计。 */
  bytes: number;
  totalBytes: number | null;
  /** 这一次尝试累计下载的字节，跨批次累加：完成后的「总量」用它。 */
  doneBytes: number;
  speedBps: number;
  /** 这一次尝试开始运行的时刻；排队中、还没开始过为 null。「用时」是 finishedAt 减去它，不含排队等待。 */
  startedAt: number | null;
  /** 第几次尝试，从 1 计。 */
  attempt: number;
  error: { code: string; message: string } | null;
  createdAt: number;
  finishedAt: number | null;
  spec: TaskSpec;
}
