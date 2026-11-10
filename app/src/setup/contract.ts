// 引导程序前后端的接口契约：app/src-tauri-setup/src/contract.rs 是它的另一半，字段和取值必须逐一对应，
// contract.test.ts 拿两边比对。

/** 安装进度事件名，载荷是 Progress。 */
export const PROGRESS_EVENT = "setup://progress";

/** 发布通道：dev 是预览版，beta 是测试版，stable 是正式版。 */
export type Channel = "dev" | "beta" | "stable";

/** switch：已装的更新，安装包在严格更慢的通道上，用户在页面上确认、或启动器带换通道开关拉起时才能装回去。 */
export type ExistingKind = "upgrade" | "same" | "newer" | "broken" | "switch";

export interface Existing {
  kind: ExistingKind;
  version: string;
  dir: string;
  /** 由 version 推出；认不出时（含解析不了、卸载项没有版本）为 null。 */
  channel: Channel | null;
}

/** 启动器的更新插件拉起时才有：命令行带了 /UPDATE。 */
export interface UpdateLaunch {
  /** 带了 /R：装完替用户重新打开启动器。 */
  relaunch: boolean;
}

/** 种类是 newer 时为什么不能装，界面按它挑说明，不拿两边的通道自己推。slower_channel 是更慢通道上更早的包、却由不带换通道开关的自动更新拉起。 */
export type NewerReason = "same_channel" | "faster_channel" | "slower_channel" | "unknown_channel";

/** too_new：数据记着的格式号高于安装包认得的号；unreadable：记号读不懂。 */
export type DataProblem = "too_new" | "unreadable";

/** 数据关拦下时的详情，探测结果与目录校验结果共用。 */
export interface DataBlock {
  problem: DataProblem;
  /** 挡下的那个记号文件。 */
  path: string;
  /** 记号里的号，读不懂时为 null。号只进日志，界面不显示。 */
  recorded: number | null;
  /** 安装包认得的号。 */
  supported: number;
  /** 读不懂的原因原文，太新时为 null。 */
  reason: string | null;
  /** 把号抬上去的版本。只有形状是落樱发过的版本号才有值，可以直接显示。 */
  writtenBy: string | null;
  /** writtenBy 所属的通道，与它同时有值。 */
  writtenByChannel: Channel | null;
}

export interface Probe {
  payloadVersion: string;
  /** 由 payloadVersion 推出，认不出时为 null。 */
  payloadChannel: Channel | null;
  defaultDir: string;
  requiredBytes: number;
  existing: Existing | null;
  interrupted: boolean;
  elevated: boolean;
  /** 交互启动时是 null。 */
  update: UpdateLaunch | null;
  /** 只在种类是 newer 时有值。 */
  newerReason: NewerReason | null;
  /** 界面能发起的安装模式，为空时什么都不能装。 */
  allowedModes: InstallMode[];
  /** 更新模式下不经页面直接装的模式，只会是 upgrade 或 switch；为 null 时走交互的页面。 */
  unattended: InstallMode | null;
  /** 用户在页面上确认安装时会写交接记录，启动器下次启动据它对上更新通道；界面据此用「换到」的说法。 */
  handoff: boolean;
  /** 数据关拦下时有值，这时允许的模式为空。 */
  dataBlock: DataBlock | null;
}

/** switch：换到更慢的通道，装回较早的版本。 */
export type InstallMode = "fresh" | "upgrade" | "repair" | "switch";

export interface InstallPlan {
  mode: InstallMode;
  /** 只有首装带目录：升级、修复和换通道装回探测到的登记目录，不让界面换位置，换了原来那份就成孤儿。 */
  dir: string | null;
  desktopShortcut: boolean;
}

/** data_incompatible：被数据关拦下，只作标志，太新还是读不懂、谁写的，看 DirCheck 的 dataBlock。 */
export type DirIssue = "empty" | "relative" | "bang" | "forbidden" | "minecraft" | "network" | "unwritable" | "no_space" | "data_incompatible";

export interface DirCheck {
  normalized: string;
  issue: DirIssue | null;
  hasConfig: boolean;
  notEmpty: boolean;
  /** notEmpty 时在 normalized 末尾追加了一层程序名文件夹；目录本来就叫这个名字时不追加，为 false。 */
  appended: boolean;
  freeBytes: number;
  /** issue 是 data_incompatible 时有值，其余为 null。 */
  dataBlock: DataBlock | null;
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
