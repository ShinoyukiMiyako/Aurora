// 引导程序前后端的接口契约：app/src-tauri-setup/src/contract.rs 是它的另一半，字段和取值必须逐一对应，
// contract.test.ts 拿两边比对。

/** 安装进度事件名，载荷是 Progress。 */
export const PROGRESS_EVENT = "setup://progress";

export type ExistingKind = "upgrade" | "same" | "newer" | "broken";

export interface Existing {
  kind: ExistingKind;
  version: string;
  dir: string;
}

/** 启动器的更新插件拉起时才有：命令行带了 /UPDATE。 */
export interface UpdateLaunch {
  /** 带了 /R：装完替用户重新打开启动器。 */
  relaunch: boolean;
}

export interface Probe {
  payloadVersion: string;
  defaultDir: string;
  requiredBytes: number;
  existing: Existing | null;
  interrupted: boolean;
  elevated: boolean;
  /** 交互启动时是 null。 */
  update: UpdateLaunch | null;
}

export type InstallMode = "fresh" | "upgrade" | "repair";

export interface InstallPlan {
  mode: InstallMode;
  /** 只有首装带目录：升级和修复装回探测到的登记目录，不让界面换位置，换了原来那份就成孤儿。 */
  dir: string | null;
  desktopShortcut: boolean;
}

export type DirIssue = "empty" | "relative" | "bang" | "forbidden" | "minecraft" | "network" | "unwritable" | "no_space";

export interface DirCheck {
  normalized: string;
  issue: DirIssue | null;
  hasConfig: boolean;
  notEmpty: boolean;
  /** notEmpty 时在 normalized 末尾追加了一层程序名文件夹；目录本来就叫这个名字时不追加，为 false。 */
  appended: boolean;
  freeBytes: number;
}

export type Phase = "unpack" | "write" | "verify";

export interface Progress {
  phase: Phase;
  /** 0 到 100，只增不减。 */
  percent: number;
  slow: boolean;
}

export type FailureCode = "dir_unwritable" | "disk_full" | "extract_failed" | "payload_exit" | "verify_failed";

export interface Failure {
  code: FailureCode;
  /** payload_exit 时是十进制退出码，其余是给日志和反馈看的原文。 */
  detail: string;
}

const FAILURE_CODES: Readonly<Record<FailureCode, true>> = {
  dir_unwritable: true,
  disk_full: true,
  extract_failed: true,
  payload_exit: true,
  verify_failed: true,
};

/** install 拒绝时带的是 Failure；IPC 本身坏掉时是别的东西，不能当安装失败显示。 */
export function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false;
  const { code, detail } = value as { code?: unknown; detail?: unknown };
  return typeof detail === "string" && typeof code === "string" && Object.hasOwn(FAILURE_CODES, code);
}
