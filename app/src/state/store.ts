// 启动器的状态容器：一份原始状态 + 事件订阅 + 全部动作。与 React 解耦（LauncherProvider 只做订阅），
// 测试可以直接实例化它并配合假定时器驱动。
//
// - 事件订阅只在 start() 时建立一次、stop() 时全部撤销；先订阅再首查，首查期间的事件不会漏掉。
// - 动作返回 Promise，失败原样抛给调用方，由外层（useRunner）统一转成通知；这里不吞错误。
//   动作在后台继续的工作（任务完成后的落地、退出后的崩溃报告）没有调用方可抛，经 report 进通知并写控制台。
// - 对外的 LauncherState 由原始状态派生（实例的「安装中」「固定」由任务与侧栏固定推出）：整份按原始状态记忆，
//   实例列表另按输入记忆、按实例增量复用（见 StateDeriver），高频的下载进度与游戏日志不让它换引用。

import {
  ACTION_ERROR,
  APP_NOT_APPROVED,
  BOOT_SLICE_ERROR,
  CONFIRM_COPY,
  DEVICE_CODE_TIMEOUT_CODE,
  isCrashCategory,
  NEXT_LAUNCH_SUFFIX,
  TASK_TEXT,
  TASK_TOAST,
  TOAST_COPY,
  failureCopy,
  failureToastLabel,
  crashCategoryLabel,
  taskFailureReason,
  SESSION_COPY,
  type CrashCategoryName,
  type FailureFixKind,
} from "../copy/flows";
import {
  accountFromDto,
  authServerFromDto,
  authlibProfileFromDto,
  instanceFromDto,
  instanceSettingsFromDto,
  instanceSettingsToDto,
  logLineFromDto,
  sessionDownloadFromDto,
  settingsFromDto,
  settingsPatchToConfig,
  taskFromRecord,
  taskToRecord,
  JAVA_AUTO,
  type Account,
  type AuthServer,
  type AuthlibProfile,
  type InstanceSettings,
  type InstanceSummary,
  type Settings,
  type SettingsPatch,
} from "../domain/adapt";
import {
  FAILURE_TOAST_MERGE_MS,
  INSTANCE_RESCAN_MIN_MS,
  SIDEBAR_PIN_LIMIT,
  STOP_TIMEOUT_MS,
  STOPPED_LINGER_MS,
  DEVICE_CODE_FETCH_TIMEOUT_MS,
  TASK_JOURNAL_DEBOUNCE_MS,
} from "../domain/limits";
import { instanceNameError, validateOfflineName } from "../domain/rules";
import type { FailureCode, LoaderKind, Platform, Task, TaskError, TaskKind } from "../domain/types";
import * as accountsIpc from "../ipc/accounts";
import { invoke, type UnlistenFn } from "../ipc/bridge";
import * as configIpc from "../ipc/config";
import { lastCrash } from "../ipc/diagnostics";
import { installMod, type InstallableResourceType, type ResourceInstallOutcomeDto } from "../ipc/discover";
import { CANCELLED_ERROR_CODE, IpcError, isCancelled, isIpcError } from "../ipc/errors";
import { listHistory, rollback as rollbackIpc, rollbackChecks } from "../ipc/history";
import * as instancesIpc from "../ipc/instances";
import type {
  BackupResultDto,
  DeletionPreviewDto,
  ExportResultDto,
  FolderTarget,
  InstallResultDto,
  InstanceDto,
  RestoreResultDto,
  WorldBackupListDto,
} from "../ipc/instances";
import * as javaIpc from "../ipc/java";
import type { InstalledRuntimeDto, JavaInstallationDto, RemoveJavaPathDto } from "../ipc/java";
import * as launchIpc from "../ipc/launch";
import { blockedFilesOf, claimBlockedFiles, downloadsFolder, parseBlockedFiles, type BlockedFileDto, type ClaimReportDto, type ModpackExportOptions, type ModpackExportOutcomeDto, type ModpackInstallOutcomeDto, type ModpackSource } from "../ipc/modpack";
import * as modsIpc from "../ipc/mods";
import { completeFirstRun, isFirstRun, listPinnedServers, setPinnedServerInstance, setPinnedServers, type PinnedServerDto } from "../ipc/system";
import * as tasksIpc from "../ipc/tasks";
import type { CoreEvent } from "../ipc/tasks";
import { describeError, errorRecord } from "./errors";
import { MANUAL_LOGIN, type DeviceLogin, type LoginIntent, type LoginKind, type LoginState } from "./login";
import { network as appNetwork, type NetworkMonitor } from "./online";
import { MODPACK_SUMMARY_RESOURCE } from "./queries/discover";
import { invalidate as invalidateResources, resources } from "./resource";
import type { Route } from "./route";
import {
  appendSessionLogs,
  applyPhase,
  isFailureCode,
  isLoadingPhase,
  isSessionActive,
  sessionCancelled,
  sessionCrashClue,
  sessionExited,
  sessionFailed,
  sessionLaunched,
  startSession,
  type SessionCrash,
  type SessionState,
} from "./session";
import {
  applyCompositeDownload,
  applyTaskDownload,
  attemptTaskId,
  awaitsManualFiles,
  clearFinished,
  completeCompositeStep,
  compositeProgress,
  findDuplicate,
  INSTANCE_TASK_COMMANDS,
  isActiveTask,
  markCancelled,
  markDone,
  markFailed,
  markRunning,
  modFilesBeingUpdated,
  newTask,
  restoreJournal,
  retryTask,
  sharedSavesKeys,
  startComposite,
  taskByAttempt,
  tasksToStart,
  trimHistory,
  type CompositeProgress,
  WORLD_TASK_COMMANDS,
  type DownloadSnapshot,
  type TaskDraft,
} from "./tasks";
import {
  detachInstanceToasts,
  detachToasts,
  dismissToast,
  EMPTY_TOASTS,
  expireToasts,
  instanceAction,
  nextToastDeadline,
  pauseToasts,
  pushToast,
  resumeToasts,
  retargetToasts,
  type Toast,
  type ToastAction,
  type ToastPauseReason,
  type ToastTone,
  type ToastsState,
} from "./toasts";

// 页面不能引用 ipc/：需要手动下载的文件清单与认领结果的形状经这里给出
export type { BlockedFileDto, ClaimReportDto, PackFileAvailability, PackModDto } from "../ipc/modpack";

/**
 * 一次认领检查的结局：后端给出的认领结果，或选的文件夹读不了（不存在、不是文件夹、没有权限，错误码 io）时的后端原文。
 * 文件夹读不了是这次检查本身的结果，清单原位说明；别的失败照常 reject，交给外层统一处理。
 */
export type ClaimOutcome = { kind: "report"; report: ClaimReportDto } | { kind: "folder_error"; message: string };

// ---------------------------------------------------------------- 状态形状

/** 页面与启动层不直接引用 ipc/，直达目标的形状经这里拿。 */
export type { QuickPlayArg } from "../ipc/launch";

export type Slice = "settings" | "accounts" | "instances" | "pins" | "tasks" | "firstRun";
export type SliceStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: Error };

/** 另一实例占着游戏进程时再点启动：外壳据此弹替换确认，回答经 resolveLaunchPrompt 交回。 */
export interface LaunchPrompt {
  instanceId: string;
  occupantId: string;
  occupantPhase: "loading" | "running";
  /** 确认替换后这次启动要直达的世界或服务器；普通启动为 null。 */
  quickPlay: launchIpc.QuickPlayArg | null;
}

/** 新实例就绪后接着装的一个开局 Mod（Modrinth 上的工程与挑好的版本）。 */
export interface StarterPick {
  projectId: string;
  modVersionId: string;
  /** Mod 名（任务里这一项的标题）。 */
  title: string;
  /** 平台声明的文件大小，组合任务的进度按它折算；平台没声明为 null。 */
  fileSize: number | null;
}

/** 新建实例的入参。cover 为封面预设 id。 */
export interface CreateInstanceSpec {
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  /** 原版为 null；带加载器时必填。 */
  loaderVersion: string | null;
  cover: string;
  /** 装好后沿用默认设置（只补实例里没有的文件）；不给与 false 相同。 */
  useTemplate?: boolean;
  /** 实例就绪后接着装的开局 Mod，按勾选的顺序、API 在前；不给与空列表相同。 */
  starterMods?: StarterPick[];
}

/** 导入整合包的入参：名称就是新实例的 id，入队时即可拿到。 */
export interface InstallModpackSpec {
  source: ModpackSource;
  /** 新实例名。 */
  name: string;
  cover: string;
  /** 整合包自己的名字与版本（任务标题与详情用）。 */
  packName: string;
  packVersion: string;
  /** 整合包含的 Mod 数；导入前拿不到（平台版本没声明包含的工程、本地包的清单不区分 Mod）时为 null，任务详情与完成通知省略这一段。 */
  modCount: number | null;
  mcVersion: string;
  loader: LoaderKind;
  loaderVersion: string | null;
  /** 不装的可选文件落点（本地 .mrpack 预览里取消勾选的）；原样进任务参数，重试照旧带上。 */
  excludedOptional: readonly string[];
}

export interface InstallResourceSpec {
  resourceType: InstallableResourceType;
  platform: Platform;
  projectId: string;
  /** 资源名（任务标题、通知用）。 */
  name: string;
  /** 每个目标实例各入队一个任务。fileVersionId 为该实例要装的版本（Modrinth 版本 id / CurseForge 文件 id）。 */
  targets: { instanceId: string; fileVersionId: string; world: string | null }[];
}

export type AuthlibLoginOutcome =
  | { status: "logged_in"; account: Account }
  | { status: "select_profile"; pendingId: string; serverName: string; profiles: AuthlibProfile[] };

/** 入队时记下的、完成落地要用的上下文。任务日志不保存它：重启后恢复的任务按命令参数推出能推出的部分。 */
type TaskMeta =
  | {
      type: "create";
      name: string;
      mcVersion: string;
      loader: LoaderKind;
      loaderVersion: string | null;
      cover: string | null;
      /**
       * 入队时侧栏还有空位：安装期间占位项就显示在侧栏末尾（带安装进度）。实例目录装好之前后端不认这个 id，
       * 所以安装期间只在派生状态里固定，装好后再写进侧栏固定列表。
       */
      autoPin: boolean;
      /** 就绪后接着装的开局 Mod；重启后恢复的新建任务从参数里的 starterMods 读回。 */
      starter: StarterPick[];
    }
  | {
      type: "modpack";
      name: string;
      cover: string | null;
      modCount: number | null;
      mcVersion: string | null;
      loader: LoaderKind;
      loaderVersion: string | null;
    }
  /** starter：失败的新建改排补全时接过来的开局 Mod，补全好了照样接着装，重启后从参数读回；别的补全为空。 */
  | { type: "repair"; launchAfter: boolean; starter: StarterPick[] }
  /** pinFor：下载完把这个实例的 Java 固定为新装的运行时（崩溃诊断「下载 Java N」）。 */
  | { type: "java"; major: number; launchAfter: string | null; pinFor: string | null }
  | { type: "mods"; instanceId: string; name: string; dependencies: number }
  /** 新实例的开局 Mod：一个组合任务装好勾选的几个。 */
  | { type: "starter"; instanceId: string; count: number }
  | { type: "resource"; instanceId: string; resourceType: InstallableResourceType; name: string }
  | { type: "update"; instanceId: string; name: string }
  | { type: "updates"; instanceId: string }
  /** 备份、导出、恢复存档。world 是存档文件夹名，name 是任务标题与通知里写的存档名。 */
  | { type: "world"; instanceId: string; world: string; name: string; op: "backup" | "restore" | "export" }
  /** name：整合包名称（完成通知用），与命令参数 options.name 相同。 */
  | { type: "export"; name: string };

export type { WorldBackupDto, WorldBackupListDto } from "../ipc/instances";

/** 存档备份列表的查询 key：world-backups:<实例 id>:<存档文件夹名>。共用存档的几个实例看到同一份，失效时按前缀整个失效。 */
export const WORLD_BACKUPS_RESOURCE = "world-backups";

export function worldBackupsKey(instanceId: string, world: string): string {
  return `${WORLD_BACKUPS_RESOURCE}:${instanceId}:${world}`;
}

interface RawState {
  status: Record<Slice, SliceStatus>;
  settings: Settings | null;
  accounts: Account[];
  currentAccountId: string | null;
  /** 扫描结果的领域形状，状态与固定按无任务、无固定算；派生时再叠加。 */
  scanned: InstanceSummary[];
  pins: string[];
  firstRun: boolean | null;
  session: SessionState | null;
  tasks: Task[];
  taskMeta: Readonly<Record<string, TaskMeta>>;
  /**
   * 已结束、但这次结束触发的那次重扫还没落定的新建与导入任务。它们的占位项留到重扫落定：否则实例先从列表里
   * 消失，外壳随即把指向它的实例页路由剪掉，等重扫回来用户已经被送回了上一页。
   */
  landing: readonly string[];
  /** 本次运行里失败、用户还没看过的尝试（attemptTaskId）。重试后再失败是新的一次尝试，重新算未看。 */
  unseenFailures: readonly string[];
  toasts: ToastsState;
  login: LoginState | null;
  launchPrompt: LaunchPrompt | null;
  lastRename: { from: string; to: string; seq: number } | null;
}

export interface LauncherState {
  status: Readonly<Record<Slice, SliceStatus>>;
  /** 全局设置；加载完成前为 null。 */
  settings: Settings | null;
  accounts: Account[];
  currentAccountId: string | null;
  /** 扫描到的实例加上新建、导入任务的占位项。 */
  instances: InstanceSummary[];
  /** 主页「继续游玩」与快捷启动指向的实例；配置里的实例已不存在时为 null。 */
  selectedInstanceId: string | null;
  /** 侧栏固定的实例，按顺序；末尾含安装中、入队时侧栏还有空位而自动固定的新实例。 */
  sidebarPins: string[];
  firstRun: boolean | null;
  session: SessionState | null;
  tasks: Task[];
  /**
   * 用户还没看过的失败任务个数：本次运行里失败、此刻仍是失败状态、还没打开过下载快览或进过下载任务页的。
   * 上次关闭时中断的不算，那是用户确认过的。
   */
  unseenFailures: number;
  toasts: Toast[];
  login: LoginState | null;
  launchPrompt: LaunchPrompt | null;
  /** 最近一次重命名：外壳据此把历史里的旧 id 换成新 id，而不是当成实例被删除。 */
  lastRename: { from: string; to: string; seq: number } | null;
}

/** 启动失败修复动作的落点：导航类给路由，命令类给要执行的函数与它失败时的通知标题。 */
export type FailureFixTarget = { to: Route } | { run: () => Promise<void>; errorTitle: string };

export interface ToastOptions {
  action?: ToastAction;
}

export interface LauncherActions {
  // 通知
  toast(tone: ToastTone, title: string, body?: string, opts?: ToastOptions): string;
  dismissToast(id: string): void;
  pauseToasts(reason: ToastPauseReason): void;
  resumeToasts(reason: ToastPauseReason): void;
  // 账户与登录
  selectAccount(uuid: string): Promise<void>;
  removeAccount(uuid: string): Promise<void>;
  /**
   * 刷新名字、皮肤与令牌。凭据被判失效不是操作失败：账户重新读出来已是 expired，原位显示「重新登录」，
   * 返回 "expired" 而不抛错；其余失败原样抛出。
   */
  refreshAccount(uuid: string): Promise<"refreshed" | "expired" | "not_approved">;
  addOfflineAccount(name: string): Promise<Account>;
  openLogin(kind: LoginKind, intent?: LoginIntent): Promise<void>;
  /** 拖进窗口的外置登录服务器链接：打开外置登录弹窗，填好这个地址并自动探测服务器。 */
  openAuthlibServer(serverUrl: string): Promise<void>;
  closeLogin(): Promise<void>;
  startMicrosoftLogin(intent?: LoginIntent): Promise<void>;
  closeMicrosoftLogin(): Promise<void>;
  probeAuthServer(url: string): Promise<AuthServer>;
  authlibLogin(serverUrl: string, username: string, password: string): Promise<AuthlibLoginOutcome>;
  selectAuthlibProfile(pendingId: string, profileUuid: string): Promise<Account>;
  relogin(accountUuid: string, intent: LoginIntent): Promise<void>;
  // 实例
  selectInstance(id: string): Promise<void>;
  togglePin(id: string): Promise<void>;
  setSidebarPins(ids: string[]): Promise<void>;
  createInstance(spec: CreateInstanceSpec): Promise<string>;
  installModpack(spec: InstallModpackSpec): Promise<string>;
  /**
   * 把实例导出为 .mrpack：入队一个挂在实例上的任务，返回任务 id（同一份导出已在队列里时返回那个任务的 id）。
   * 期间实例算「改动中」，不挡启动。options.destination 由系统保存对话框给出。
   */
  exportModpack(id: string, options: ModpackExportOptions): Promise<string>;
  previewInstanceDeletion(id: string): Promise<DeletionPreviewDto>;
  deleteInstance(id: string, worldCount: number): Promise<void>;
  renameInstance(id: string, name: string): Promise<string>;
  updateInstanceSettings(id: string, patch: Partial<InstanceSettings>): Promise<InstanceSettings>;
  /** reinstallLoader：把加载器原样重装一遍，走同一个补全任务；游戏版本、Mod、配置与存档都不变。 */
  repairInstance(id: string, opts?: { launchAfter?: boolean; reinstallLoader?: boolean }): Promise<void>;
  /** 把实例的设置文件存为新实例的默认设置；成功后默认设置的查询失效并通知。 */
  saveInstanceAsTemplate(id: string): Promise<void>;
  clearTemplate(): Promise<void>;
  openFolder(target: FolderTarget, id?: string | null, world?: string | null): Promise<void>;
  /** 用系统默认浏览器打开一个 http(s) 网址；别的协议直接抛错。打开失败原样抛出。 */
  openExternal(url: string): Promise<void>;
  /** 系统的下载文件夹，选文件夹对话框的默认位置。 */
  downloadsFolder(): Promise<string>;
  /** 从用户选的文件夹里认领需要手动下载的文件；不登记任务、不占实例。 */
  claimBlockedFiles(folder: string, files: readonly BlockedFileDto[]): Promise<ClaimOutcome>;
  refreshInstances(): Promise<void>;
  // 启动会话
  launch(id: string): Promise<void>;
  /**
   * 启动并直达一个世界或一台服务器，与 launch 走同一条拦截（同实例已在加载或运行时不重复、别的实例占着时弹替换确认、
   * 没有账户时先登录再继续）。损坏与安装中的实例不提供直达，入口应当禁用，调到这里直接抛错。
   */
  quickPlay(id: string, target: launchIpc.QuickPlayArg): Promise<void>;
  stop(): Promise<void>;
  dismissSession(): void;
  resolveLaunchPrompt(accept: boolean): Promise<void>;
  /** 当前启动失败会话的修复动作落点；会话不是 failed 时抛错。 */
  failureFix(kind: FailureFixKind): FailureFixTarget;
  // Mod 与资源
  toggleMod(instanceId: string, fileName: string, enabled: boolean): Promise<void>;
  /**
   * 批量启用或停用：逐个文件，一个失败不中断其余的。全部成功给 info 通知，有失败给 warning 通知并写明原因；
   * 整次被拒（实例忙碌等）照常抛出。
   */
  toggleMods(instanceId: string, fileNames: readonly string[], enabled: boolean): Promise<void>;
  /**
   * 把本地 jar 复制进实例：逐个文件，一个被拒不中断其余的。全部加成给 success 通知，有被拒的给 warning 通知并写明原因；
   * 整次被拒（实例忙碌等）照常抛出。
   */
  addLocalMods(instanceId: string, paths: readonly string[]): Promise<void>;
  updateMod(instanceId: string, fileName: string): Promise<void>;
  /**
   * 不给 picked：现查一次可更新项，全部更新（没有可更新的提示都已是最新）。
   * 给了：只更新这几项（更新预览里勾选的），一项按单个更新入队，多项合成一个任务；空数组直接报错。
   */
  updateAllMods(instanceId: string, picked?: readonly modsIpc.UpdateCandidate[]): Promise<void>;
  removeMod(instanceId: string, fileName: string, name: string): Promise<void>;
  /** 逐项移除；被拒的那几项记为失败、不中断其余的，结束后按结果给一条通知。 */
  removeMods(instanceId: string, files: readonly { fileName: string; name: string }[]): Promise<void>;
  /** 忽略（或锁定）这个 Mod 的更新；hold 为 null 恢复检查。只改记录不碰文件，游戏运行中也可用。 */
  setModUpdateHold(instanceId: string, fileName: string, name: string, hold: modsIpc.UpdateHold | null): Promise<void>;
  installResource(spec: InstallResourceSpec): Promise<void>;
  rollback(instanceId: string, eventId: string): Promise<void>;
  /** launchAfter：装好后通知带「启动」这个实例；pinFor：装好后把这个实例的 Java 固定为新装的运行时。 */
  installJava(major: number, opts?: { launchAfter?: string; pinFor?: string }): Promise<void>;
  // 存档备份（world 是存档文件夹名，name 是界面上显示的存档名）
  /** 入队一个手动备份任务；同一件事已在队列里时只提示重复。 */
  backupWorld(instanceId: string, world: string, name: string): Promise<void>;
  /** 入队一个恢复任务：用 file 这份备份替换现在的存档。调用前由界面确认。 */
  restoreWorldBackup(instanceId: string, world: string, name: string, file: string): Promise<void>;
  /** 入队一个导出任务：把存档打包到 dest（系统保存对话框选定的 .zip）。 */
  exportWorld(instanceId: string, world: string, name: string, dest: string): Promise<void>;
  /** 把一份备份移入回收站（不经任务队列，不确认）。 */
  deleteWorldBackup(instanceId: string, world: string, file: string): Promise<void>;
  listWorldBackups(instanceId: string, world: string): Promise<WorldBackupListDto>;
  /** 在系统文件管理器里选中启动器自己产出的文件或文件夹（存档备份区里的、这次运行里导出的）；别的路径与打开失败原样抛出。 */
  revealPath(path: string): Promise<void>;
  // 下载任务
  cancelTask(id: string): Promise<void>;
  cancelAllTasks(): Promise<void>;
  retryTask(id: string): void;
  /** 把全部失败的任务重新排进队列（已有同一件事在队列里的跳过），返回重新排进去的个数。 */
  retryFailedTasks(): number;
  clearFinishedTasks(): void;
  /** 打开下载快览或进入下载任务页时调用：此刻的失败都算看过了。 */
  markFailuresSeen(): void;
  flushTaskJournal(): Promise<void>;
  // 设置
  updateSettings(patch: SettingsPatch): Promise<void>;
  /** 记下一个手动指定的 Java；成功后 Java 列表重新探测、设置重读（extra_java_paths 变了）。 */
  addJavaPath(path: string): Promise<JavaInstallationDto>;
  /** 移除一条手动添加的 Java；默认 Java 可能随之改回自动选择，所以同样重读设置。 */
  removeJavaPath(path: string): Promise<RemoveJavaPathDto>;
  setGameDirectory(path: string): Promise<void>;
  /**
   * 首次启动向导第一步的提交：后端校验并落下游戏目录、收下勾选的文件夹、记下向导已完成（此后关窗口，下次直接进主页）。
   * 向导仍然挂着，接着走后面几步；收尾时调 finishFirstRun 卸载它。
   */
  commitFirstRun(gameDir: string, extraDirectories: configIpc.NamedDirectoryDto[]): Promise<void>;
  /** 向导收尾：firstRun 置为 false，外壳随即卸载向导。第一步还没提交时抛错。 */
  finishFirstRun(): void;
  /** commitFirstRun 加 finishFirstRun：提交后立即卸载向导。 */
  completeFirstRun(gameDir: string, extraDirectories: configIpc.NamedDirectoryDto[]): Promise<void>;
  togglePinServer(server: PinnedServerDto): Promise<void>;
  /** 记住（instance 为 id）或忘掉（null）某台固定服务器「加入」时用的实例；与固定的读改写排在同一条链上。 */
  setPinnedServerInstance(address: string, instance: string | null): Promise<void>;
  reload(slice: Slice): Promise<void>;
}

// ---------------------------------------------------------------- 常量与工具

/** 任务日志里允许重放的命令：防止损坏的日志让前端调用任意命令。install_mods 与 update_mods 是前端的组合任务。 */
const TASK_COMMANDS = new Set([
  "install_version",
  "install_modpack",
  "repair_instance",
  "install_java",
  "install_mod",
  "install_mods",
  "install_resource",
  "update_mod",
  "update_mods",
  ...WORLD_TASK_COMMANDS,
  "export_modpack",
]);

/**
 * 实例列表里带着结果的实例设置，改了要重扫列表：简介与封面直接显示；隔离会换掉工作目录，列表里的隔离生效值、
 * 存档数与 Mod 数随之变；自定内存直接给出 memoryMb。
 */
const LISTED_INSTANCE_SETTINGS = ["description", "cover", "isolation", "memoryMb"] as const;

/** 前端的组合任务：逐项调后端命令，中途失败或取消时前面几项已经落盘。 */
const COMPOSITE_TASKS = new Set(["install_mods", "update_mods"]);

/** opener 插件打开网址的命令（能力里已授予 opener:allow-open-url，默认作用域放行 http 与 https）。 */
const OPEN_URL_COMMAND = "plugin:opener|open_url";


/** refresh_account 判定凭据失效、只能重新登录时的错误码（aurora-auth 的变体名）。 */
const RELOGIN_REQUIRED_CODE = "ReloginRequired";
const APP_NOT_APPROVED_CODE = "AppNotApproved";

/** 读写本机文件失败的错误码；认领时多半是选的文件夹读不了。 */
const IO_ERROR_CODE = "io";

/** load_task_journal 在日志文件损坏或版本不符时的错误码。 */
const TASK_JOURNAL_INVALID_CODE = "task_journal_invalid";

/** 账户列表与当前账户对不上时最多连读几次。只有另一路的增删恰好夹在两条读命令之间才会对不上，重读一次就该对上。 */
const ACCOUNT_READ_ATTEMPTS = 3;

const RESOURCE_KIND: Readonly<Record<InstallableResourceType, TaskKind>> = {
  mod: "mod",
  resource_pack: "resourcepack",
  shader: "shader",
  data_pack: "datapack",
};

let idSeq = 0;
function freshId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

const INITIAL_STATUS: Record<Slice, SliceStatus> = {
  settings: { kind: "loading" },
  accounts: { kind: "loading" },
  instances: { kind: "loading" },
  pins: { kind: "loading" },
  tasks: { kind: "loading" },
  firstRun: { kind: "loading" },
};

function initialRaw(): RawState {
  return {
    status: INITIAL_STATUS,
    settings: null,
    accounts: [],
    currentAccountId: null,
    scanned: [],
    pins: [],
    firstRun: null,
    session: null,
    tasks: [],
    taskMeta: {},
    landing: [],
    unseenFailures: [],
    toasts: EMPTY_TOASTS,
    login: null,
    launchPrompt: null,
    lastRename: null,
  };
}

/** 任务失败记录：需要手动下载的文件清单随记录进任务日志，失败态据此列出清单、重新检查后重试。 */
function failureRecord(error: unknown): TaskError {
  const record = errorRecord(error);
  const blocked = blockedFilesOf(error);
  return blocked === null ? record : { ...record, blocked_files: blocked };
}

/** 任务日志里读回的失败记录：带着清单时逐项校验，形状不对按日志损坏报错；较早的日志没有清单，原样读入。 */
function journalTask(task: Task): Task {
  const error = task.error;
  if (error === null || error.blocked_files === undefined) return task;
  return { ...task, error: { ...error, blocked_files: parseBlockedFiles(error.blocked_files, `任务 ${task.id} 的 error.blocked_files`) } };
}

function strArg(args: Record<string, unknown>, key: string, command: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`任务 ${command} 的参数 ${key} 应为字符串`);
  return value;
}

function nullableStrArg(args: Record<string, unknown>, key: string, command: string): string | null {
  const value = args[key];
  if (value !== null && typeof value !== "string") throw new Error(`任务 ${command} 的参数 ${key} 应为字符串或 null`);
  return value;
}

function loaderOfArg(value: string | null): LoaderKind {
  if (value === null) return "vanilla";
  if (value === "fabric" || value === "quilt" || value === "forge" || value === "neoforge") return value;
  throw new Error(`未知的加载器：${value}`);
}

/** 重启后恢复的任务没有入队时的上下文，按命令参数推出能推出的部分。 */
function metaFromSpec(task: Task): TaskMeta | null {
  const { command, args } = task.spec;
  switch (command) {
    case "install_version":
      return {
        type: "create",
        name: strArg(args, "targetName", command),
        mcVersion: strArg(args, "id", command),
        loader: loaderOfArg(nullableStrArg(args, "loader", command)),
        loaderVersion: nullableStrArg(args, "loaderVersion", command),
        cover: null,
        // 重启后恢复的新建任务不知道当时侧栏的余量：按「有空位就固定」处理
        autoPin: true,
        starter: starterPicksArg(args, command),
      };
    case "install_modpack":
      return { type: "modpack", name: strArg(args, "name", command), cover: null, modCount: null, mcVersion: null, loader: "vanilla", loaderVersion: null };
    case "repair_instance":
      return { type: "repair", launchAfter: false, starter: starterPicksArg(args, command) };
    case "install_java": {
      const major = args.requiredMajor;
      if (typeof major !== "number") throw new Error("任务 install_java 缺少 requiredMajor");
      return { type: "java", major, launchAfter: null, pinFor: null };
    }
    case "install_mods": {
      const items = modItems(args);
      if (args.starter === true) return { type: "starter", instanceId: strArg(args, "versionId", command), count: items.length };
      return { type: "mods", instanceId: strArg(args, "versionId", command), name: items[0].title, dependencies: items.length - 1 };
    }
    case "update_mods":
      return { type: "updates", instanceId: strArg(args, "versionId", command) };
    // 任务日志只记了文件夹名，恢复出来的任务按文件夹名称呼存档
    case "backup_world":
    case "export_world":
    case "restore_world_backup": {
      const world = strArg(args, "world", command);
      const op = command === "backup_world" ? "backup" : command === "export_world" ? "export" : "restore";
      return { type: "world", instanceId: strArg(args, "id", command), world, name: world, op };
    }
    case "export_modpack": {
      const options = args.options;
      if (typeof options !== "object" || options === null) throw new Error("任务 export_modpack 缺少 options");
      return { type: "export", name: strArg(options as Record<string, unknown>, "name", command) };
    }
    default:
      return null;
  }
}

interface ModItem {
  platform: Platform;
  projectId: string;
  modVersionId: string;
  title: string;
  /** 平台声明的文件大小（组合任务的进度按它折算）；平台没声明、或较早写入任务日志的记录没有这一项时为 null。 */
  fileSize: number | null;
}

/** 组合任务一项的声明大小。较早写入任务日志的记录没有这个键，与平台没声明大小同样按 null 处理。 */
function fileSizeArg(r: Record<string, unknown>, command: string): number | null {
  if (!("fileSize" in r) || r.fileSize === null) return null;
  const size = r.fileSize;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) throw new Error(`任务 ${command} 的 fileSize 应为非负数或 null：${String(size)}`);
  return size;
}

function modItems(args: Record<string, unknown>): ModItem[] {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("组合任务 install_mods 缺少 items");
  return raw.map((item: unknown, i) => {
    const r = item as Record<string, unknown>;
    if (typeof r !== "object" || r === null) throw new Error(`install_mods 第 ${i} 项不是对象`);
    const platform = r.platform;
    if (platform !== "modrinth" && platform !== "curseforge") throw new Error(`install_mods 第 ${i} 项平台不对：${String(platform)}`);
    return {
      platform,
      projectId: strArg(r, "projectId", "install_mods"),
      modVersionId: strArg(r, "modVersionId", "install_mods"),
      title: strArg(r, "title", "install_mods"),
      fileSize: fileSizeArg(r, "install_mods"),
    };
  });
}

/**
 * 新建与补全任务参数里的 starterMods：勾选的开局 Mod 跟着参数写进任务表，重启后恢复的任务据此仍会在就绪后接着装。
 * 调后端命令时去掉这个键；没勾开局 Mod 时不写这个键，较早写下的记录也没有，都按空列表处理。
 */
function starterArgs(starter: readonly StarterPick[]): { starterMods?: StarterPick[] } {
  return starter.length === 0 ? {} : { starterMods: starter.map((pick) => ({ projectId: pick.projectId, modVersionId: pick.modVersionId, title: pick.title, fileSize: pick.fileSize })) };
}

function starterPicksArg(args: Record<string, unknown>, command: string): StarterPick[] {
  if (!("starterMods" in args)) return [];
  const raw = args.starterMods;
  if (!Array.isArray(raw)) throw new Error(`任务 ${command} 的 starterMods 应为数组：${String(raw)}`);
  return raw.map((item: unknown, i) => {
    if (typeof item !== "object" || item === null) throw new Error(`任务 ${command} 的 starterMods 第 ${i} 项不是对象`);
    const r = item as Record<string, unknown>;
    return { projectId: strArg(r, "projectId", command), modVersionId: strArg(r, "modVersionId", command), title: strArg(r, "title", command), fileSize: fileSizeArg(r, command) };
  });
}

interface UpdateItem {
  fileName: string;
  platform: Platform;
  projectId: string;
  modVersionId: string;
  /** Mod 名（完成通知用）；较早写入任务日志的记录没有这一项，为 null。 */
  title: string | null;
  /** 新版本的声明大小，含义同 ModItem.fileSize。 */
  fileSize: number | null;
}

function updateItems(args: Record<string, unknown>): UpdateItem[] {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("组合任务 update_mods 缺少 items");
  return raw.map((item: unknown, i) => {
    const r = item as Record<string, unknown>;
    if (typeof r !== "object" || r === null) throw new Error(`update_mods 第 ${i} 项不是对象`);
    const platform = r.platform;
    if (platform !== "modrinth" && platform !== "curseforge") throw new Error(`update_mods 第 ${i} 项平台不对：${String(platform)}`);
    return {
      fileName: strArg(r, "fileName", "update_mods"),
      platform,
      projectId: strArg(r, "projectId", "update_mods"),
      modVersionId: strArg(r, "modVersionId", "update_mods"),
      title: "title" in r ? strArg(r, "title", "update_mods") : null,
      fileSize: fileSizeArg(r, "update_mods"),
    };
  });
}

/** 「全部更新」这一次尝试实际换掉的 Mod（重试时只含这一次换的）与它们没有照办的前置。 */
interface UpdatesOutcome {
  updated: UpdateItem[];
  skipped: string[];
}

/** 组合安装任务里各项没有照办的前置。 */
interface InstallsOutcome {
  skipped: string[];
}

/**
 * 动作失败时旁听一下错误（原样抛给调用方）：联网状态据此判断要不要探测连通性。
 * 动作内部互相调用走的是未包装的那一份，同一个错误不会被记两遍。
 */
function observeFailures(actions: LauncherActions, observe: (error: unknown) => void): LauncherActions {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(actions) as [string, (...args: unknown[]) => unknown][]) {
    wrapped[name] = (...args: unknown[]) => {
      let result: unknown;
      try {
        result = fn(...args);
      } catch (error) {
        observe(error);
        throw error;
      }
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          observe(error);
          throw error;
        });
      }
      return result;
    };
  }
  return wrapped as unknown as LauncherActions;
}

/** 等 predicate 成立；超时以 timeoutError 拒绝。 */
function waitUntil(subscribe: (listener: () => void) => () => void, predicate: () => boolean, timeoutMs: number, timeoutError: () => Error): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(timeoutError());
    }, timeoutMs);
    const unsubscribe = subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- 改名

/**
 * 命令参数里指向实例的那一项：失败任务重试时按它重新调用命令。install_version 是要建的名字：新建失败留下的半成品改了名，
 * 重试按这个名字认出半成品改排补全，不跟过去的话会在旧名字下再装一份，半成品一直留着。
 */
const INSTANCE_ARG: Readonly<Record<string, string>> = {
  install_version: "targetName",
  // 失败的导入留下半成品时才改得到名字：任务跟着实例走，半成品占着名字时后端拒绝，玩家删掉它再导入，不在旧名字下悄悄再来一份
  install_modpack: "name",
  repair_instance: "id",
  install_mod: "versionId",
  install_mods: "versionId",
  install_resource: "versionId",
  update_mod: "versionId",
  update_mods: "versionId",
  backup_world: "id",
  export_world: "id",
  restore_world_backup: "id",
  export_modpack: "id",
};

/**
 * 换游戏目录后要重取的按需数据：实例 id 只在一个游戏目录里唯一，同名实例换了目录就是另一个；游玩统计按游戏目录分开记；
 * 多人游戏列表读的是该目录下的 servers.dat。
 */
const GAME_DIR_SCOPED_RESOURCES = [
  "mods",
  "content",
  "settings",
  "history",
  "crash",
  "log",
  "mod-updates",
  "mod-changelog",
  "plan",
  "match",
  "installed-sources",
  "memory-advice",
  "play-stats",
  "servers:known",
  WORLD_BACKUPS_RESOURCE,
] as const;

/**
 * key 里带实例 id 的按需数据（<前缀>:<实例 id>…）。实例删除、改名后原 id 下没人订阅的条目还留在缓存里，之后再有实例
 * 用上这个 id（新建、导入同名实例，或把别的实例改成这个名字）时一订阅就直接拿到前一个实例的 Mod、设置、日志与安装计划，
 * 所以 id 一落到新实例上就丢掉它们。不在改名当时丢原 id 的：改名发起的页面那一刻还订阅着原 id，失效会让它按已经不在的
 * 实例重取、在缓存里留下一条报错。
 */
const INSTANCE_SCOPED_RESOURCES = ["mods", "content", "history", "crash", "log", "settings", "mod-updates", "mod-changelog", "plan", "memory-advice", WORLD_BACKUPS_RESOURCE] as const;

/** 批量动作里失败几项的通知正文：后端给的原因只有一种时照写原文，不止一种时不挑一条代表全部。 */
function batchFailureReason(messages: readonly string[]): string {
  const distinct = new Set(messages);
  if (distinct.size === 0) throw new Error("没有失败项却要写失败原因");
  return distinct.size === 1 ? messages[0] : TOAST_COPY.mixedReasons;
}

/**
 * 改名、删除只差游玩记录没跟上时命令以这个码拒绝：目录、侧栏固定与当前选中都已改好，照成功处理再提示；
 * 没改成的记录由后端记着，之后读写游玩记录时补上。其余错误照常冒泡。
 */
function playRecordsLag(err: unknown): IpcError {
  if (isIpcError(err) && err.code === instancesIpc.PLAY_RECORDS_FAILED_ERROR_CODE) return err;
  throw err;
}

/**
 * 改名只差游玩记录或存档备份没跟上时命令以这两个码之一拒绝：目录、侧栏固定与当前选中都已改好，照成功处理再分别提示。
 * 两样都没跟上时后端报的是游玩记录那一个。其余错误照常冒泡。
 */
function renameLag(err: unknown): IpcError {
  if (isIpcError(err) && (err.code === instancesIpc.PLAY_RECORDS_FAILED_ERROR_CODE || err.code === instancesIpc.WORLD_BACKUPS_NOT_MOVED_ERROR_CODE)) return err;
  throw err;
}

/** world_backups_not_moved 的 detail.path：留在旧名下的备份目录。缺了就是契约被破坏。 */
function strandedBackups(err: IpcError): string {
  const detail = err.detail;
  if (typeof detail === "object" && detail !== null && "path" in detail && typeof detail.path === "string") return detail.path;
  throw new Error(`改名报 ${err.code} 却没给出 detail.path：${err.message}`);
}

/** 改名报 play_records_failed 或 world_backups_not_moved 时的 detail.renamed_to：改名已落盘后的新 id。缺了就是契约被破坏。 */
function renamedTo(err: IpcError): string {
  const detail = err.detail;
  if (typeof detail === "object" && detail !== null && "renamed_to" in detail && typeof detail.renamed_to === "string") return detail.renamed_to;
  throw new Error(`改名报 ${err.code} 却没给出 detail.renamed_to：${err.message}`);
}

/**
 * 实例改名后任务里的实例 id 一并换掉：任务行的「查看实例」、重试时重新调用的命令参数都要指向新名字，行上写的实例名也一样。
 * 后端拒绝的是正占着实例的任务，这里换的是还没开始的（排队中）与已结束的（失败的可以重试）。
 * 标题只有补全任务写的是实例：别的写 Mod 或存档名，存档与实例同名时也不能跟着改。
 */
function renamedTask(task: Task, from: string, to: string): Task {
  if (task.instanceId !== from) return task;
  const key = INSTANCE_ARG[task.spec.command];
  const args = key !== undefined && task.spec.args[key] === from ? { ...task.spec.args, [key]: to } : task.spec.args;
  const title = task.spec.command !== "repair_instance" ? task.title : task.spec.args.reinstallLoader === true ? TASK_TEXT.reinstallLoaderTitle(to) : TASK_TEXT.repairTitle(to);
  return { ...task, instanceId: to, title, detail: TASK_TEXT.renamedDetail(task.detail, from, to), spec: { ...task.spec, args } };
}

/** 入队上下文里指向实例的字段：落地时的失效、通知文案与装好后的启动、固定都按它走。 */
function renamedMeta(meta: TaskMeta, from: string, to: string): TaskMeta {
  const swap = (value: string | null) => (value === from ? to : value);
  switch (meta.type) {
    case "mods":
    case "starter":
    case "resource":
    case "update":
    case "updates":
    case "world":
      return meta.instanceId === from ? { ...meta, instanceId: to } : meta;
    case "java":
      return meta.launchAfter === from || meta.pinFor === from ? { ...meta, launchAfter: swap(meta.launchAfter), pinFor: swap(meta.pinFor) } : meta;
    case "create":
    case "modpack":
      return meta.name === from ? { ...meta, name: to } : meta;
    case "repair":
    case "export":
      return meta;
  }
}

/** 等登录后继续的启动挂在实例上：改名在弹窗开着时落盘的话，登录后要启动的是新名字。 */
function renamedLogin(login: LoginState | null, from: string, to: string): LoginState | null {
  if (login === null || login.intent.kind !== "launch" || login.intent.instanceId !== from) return login;
  return { ...login, intent: { ...login.intent, instanceId: to } };
}

// ---------------------------------------------------------------- 派生

function countUnseen(tasks: readonly Task[], unseen: readonly string[]): number {
  if (unseen.length === 0) return 0;
  const ids = new Set(unseen);
  return tasks.filter((t) => t.status === "failed" && ids.has(attemptTaskId(t))).length;
}

/**
 * 按任务 id 记着的入队上下文与未看过的失败，只为还用得上的任务留着：入队上下文跟任务表里的任务、以及结束后还在等
 * 落地重扫的任务（与 landing 同进同出）；未看过的失败只记任务表里任务的当前这一次尝试。历史超出上限被剪掉、清除已结束、
 * 失败的新建改排补全撤下的任务，以及重试后的上一次尝试，它们的记录随之清掉，不随运行时间越积越多。
 * 没有可清的时原样返回原引用，派生的实例列表按引用记忆。
 */
function prunedTaskRefs(raw: RawState): Partial<RawState> {
  const live = new Set(raw.tasks.map((t) => t.id));
  for (const id of raw.landing) live.add(id);
  const attempts = new Set(raw.tasks.map(attemptTaskId));
  const staleMeta = Object.keys(raw.taskMeta).some((id) => !live.has(id));
  const staleUnseen = raw.unseenFailures.some((attempt) => !attempts.has(attempt));
  return {
    ...(staleMeta ? { taskMeta: Object.fromEntries(Object.entries(raw.taskMeta).filter(([id]) => live.has(id))) } : {}),
    ...(staleUnseen ? { unseenFailures: raw.unseenFailures.filter((attempt) => attempts.has(attempt)) } : {}),
  };
}

/** 活动任务对一个已扫描实例的影响：整个目录在写（安装中）、在备份或恢复存档，或者只在改动 Mod 与资源。 */
type TaskEffect = "installing" | "backing_up" | "modifying" | null;

type CreationMeta = Extract<TaskMeta, { type: "create" | "modpack" }>;

/**
 * creation：正在新建或导入这个实例的任务的入队上下文。装到一半被重扫扫到的半成品目录还没写版本 JSON，
 * 扫出来既没有版本也没有加载器；这时沿用入队时的内容，与占位项说的一致，不写成「原版 · 版本未知」。
 */
function applyTaskEffect(base: InstanceSummary, pinned: boolean, effect: TaskEffect, creation: CreationMeta | null): InstanceSummary {
  if (effect === "installing") {
    const facts = creation !== null && base.mcVersion === null ? { mcVersion: creation.mcVersion, loader: creation.loader, loaderVersion: creation.loaderVersion } : {};
    return { ...base, ...facts, pinned, status: "installing", brokenReason: null };
  }
  if (effect === null) return { ...base, pinned };
  // 列表是任务开始前扫的，后端那时还没记下占用；后端报的活动（例如运行中）比前端推断的更准，留着它。
  // 排得比任务低的例外，与后端的排序一致：实例自己的事排在被当作基底前面，备份排在 Mod 改动前面。
  const lower = base.activity === null || base.activity === "inherited" || (effect === "backing_up" && base.activity === "modifying");
  return { ...base, pinned, activity: lower ? effect : base.activity };
}

/** 实例列表与侧栏固定列表：只随扫描结果、固定列表、入队上下文与活动任务的集合变，下载进度与会话日志不影响它们。 */
interface InstancesView {
  instances: InstanceSummary[];
  sidebarPins: string[];
}

function placeholderOf(meta: Extract<TaskMeta, { type: "create" | "modpack" }>, createdAt: number, pinned: boolean): InstanceSummary {
  return {
    id: meta.name,
    name: meta.name,
    mcVersion: meta.mcVersion,
    loader: meta.loader,
    loaderVersion: meta.loaderVersion,
    extraLoaders: [],
    releaseType: null,
    javaMajor: null,
    quickPlay: null,
    description: null,
    cover: meta.cover,
    pinned,
    status: "installing",
    brokenReason: null,
    createdAt,
    lastPlayedAt: null,
    playtimeMin: 0,
    playError: null,
    dirError: null,
    modCount: null,
    worldCount: null,
    isolated: null,
    memoryMb: null,
    modpack: null,
    modpackError: null,
    lastCrashAt: null,
    lastCrashError: null,
    activity: "installing",
    usedBy: null,
    settingsError: null,
    incomplete: null,
    placeholder: true,
  };
}

/**
 * 原始状态到对外状态的派生，按输入分别记忆。下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批，
 * 每次都会换掉原始状态；如果每次都重建实例对象，按 state.instances 做依赖或做选择的组件就跟着每秒重渲染十次。
 *
 * - 实例列表：扫描结果、固定列表、入队上下文都是同一份引用，活动任务的集合（id 与所挂实例）也没变时，整份复用上一次的。
 * - 必须重算时按实例增量：一个实例的扫描结果、固定与否、活动任务带来的状态（安装中、备份中或改动中）都没变，就复用上一次的那个对象。
 */
class StateDeriver {
  private lastInputs: { scanned: InstanceSummary[]; pins: string[]; taskMeta: RawState["taskMeta"]; landing: RawState["landing"]; activeKey: string } | null = null;
  private lastView: InstancesView | null = null;
  private scannedCache = new Map<string, { base: InstanceSummary; pinned: boolean; effect: TaskEffect; creation: CreationMeta | null; value: InstanceSummary }>();
  private placeholderCache = new Map<string, { meta: TaskMeta; createdAt: number; pinned: boolean; value: InstanceSummary }>();

  derive(raw: RawState): LauncherState {
    const { instances, sidebarPins } = this.instancesView(raw);
    const selected = raw.settings === null ? null : raw.settings.selectedVersion;
    return {
      status: raw.status,
      settings: raw.settings,
      accounts: raw.accounts,
      currentAccountId: raw.currentAccountId,
      instances,
      selectedInstanceId: selected !== null && instances.some((i) => i.id === selected) ? selected : null,
      sidebarPins,
      firstRun: raw.firstRun,
      session: raw.session,
      tasks: raw.tasks,
      unseenFailures: countUnseen(raw.tasks, raw.unseenFailures),
      toasts: raw.toasts.items,
      login: raw.login,
      launchPrompt: raw.launchPrompt,
      lastRename: raw.lastRename,
    };
  }

  private instancesView(raw: RawState): InstancesView {
    const active = raw.tasks.filter(isActiveTask);
    const activeKey = active.map((t) => `${t.id}|${t.spec.command}|${t.instanceId === null ? "" : t.instanceId}`).join("\n");
    const last = this.lastInputs;
    if (
      this.lastView !== null &&
      last !== null &&
      last.scanned === raw.scanned &&
      last.pins === raw.pins &&
      last.taskMeta === raw.taskMeta &&
      last.landing === raw.landing &&
      last.activeKey === activeKey
    ) {
      return this.lastView;
    }
    const view = this.compute(raw, active);
    this.lastInputs = { scanned: raw.scanned, pins: raw.pins, taskMeta: raw.taskMeta, landing: raw.landing, activeKey };
    // 内容没变就连数组一起复用：例如一个下载任务结束、另一个开始，但它们挂的实例不变
    const prev = this.lastView;
    this.lastView =
      prev !== null && sameItems(prev.instances, view.instances) && sameItems(prev.sidebarPins, view.sidebarPins)
        ? prev
        : {
            instances: prev !== null && sameItems(prev.instances, view.instances) ? prev.instances : view.instances,
            sidebarPins: prev !== null && sameItems(prev.sidebarPins, view.sidebarPins) ? prev.sidebarPins : view.sidebarPins,
          };
    return this.lastView;
  }

  private compute(raw: RawState, active: readonly Task[]): InstancesView {
    const installing = new Set<string>();
    const backingUp = new Set<string>();
    const modifying = new Set<string>();
    const creating = new Map<string, CreationMeta>();
    for (const t of active) {
      if (t.instanceId === null) continue;
      (INSTANCE_TASK_COMMANDS.has(t.spec.command) ? installing : WORLD_TASK_COMMANDS.has(t.spec.command) ? backingUp : modifying).add(t.instanceId.toLowerCase());
      const meta = raw.taskMeta[t.id];
      if (meta !== undefined && (meta.type === "create" || meta.type === "modpack")) creating.set(meta.name.toLowerCase(), meta);
    }
    const scannedCache = new Map<string, { base: InstanceSummary; pinned: boolean; effect: TaskEffect; creation: CreationMeta | null; value: InstanceSummary }>();
    const instances: InstanceSummary[] = raw.scanned.map((base) => {
      const key = base.id.toLowerCase();
      const effect: TaskEffect = installing.has(key) ? "installing" : backingUp.has(key) ? "backing_up" : modifying.has(key) ? "modifying" : null;
      const pinned = raw.pins.includes(base.id);
      const found = creating.get(key);
      const creation = found === undefined ? null : found;
      const cached = this.scannedCache.get(base.id);
      const value =
        cached !== undefined && cached.base === base && cached.pinned === pinned && cached.effect === effect && cached.creation === creation
          ? cached.value
          : applyTaskEffect(base, pinned, effect, creation);
      scannedCache.set(base.id, { base, pinned, effect, creation, value });
      return value;
    });
    this.scannedCache = scannedCache;

    const known = new Set(instances.map((i) => i.id.toLowerCase()));
    const sidebarPins = [...raw.pins];
    const placeholderCache = new Map<string, { meta: TaskMeta; createdAt: number; pinned: boolean; value: InstanceSummary }>();
    const landing = new Set(raw.landing);
    for (const task of raw.tasks) {
      if (!isActiveTask(task) && !landing.has(task.id)) continue;
      const meta = raw.taskMeta[task.id];
      if (meta === undefined || (meta.type !== "create" && meta.type !== "modpack")) continue;
      if (known.has(meta.name.toLowerCase())) continue;
      known.add(meta.name.toLowerCase());
      if (meta.type === "create" && meta.autoPin && sidebarPins.length < SIDEBAR_PIN_LIMIT && !sidebarPins.includes(meta.name)) sidebarPins.push(meta.name);
      const pinned = sidebarPins.includes(meta.name);
      const cached = this.placeholderCache.get(task.id);
      const value =
        cached !== undefined && cached.meta === meta && cached.createdAt === task.createdAt && cached.pinned === pinned
          ? cached.value
          : placeholderOf(meta, task.createdAt, pinned);
      placeholderCache.set(task.id, { meta, createdAt: task.createdAt, pinned, value });
      instances.push(value);
    }
    this.placeholderCache = placeholderCache;
    return { instances, sidebarPins };
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// ---------------------------------------------------------------- 容器

export class LauncherStore {
  private raw: RawState = initialRaw();
  private view: LauncherState | null = null;
  private viewOf: RawState | null = null;
  private readonly deriver = new StateDeriver();
  private listeners = new Set<() => void>();

  private started = false;
  private booted = false;
  private unlisteners: UnlistenFn[] = [];
  private disposed = false;
  private subscriptionGen = 0;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  private journalTimer: ReturnType<typeof setTimeout> | null = null;
  private loginGen = 0;
  private lastScanAt = 0;
  /** 实例重扫的发出序号与已采纳的最晚序号（见 fetchInstances）。 */
  private scanIssued = 0;
  private scanApplied = 0;
  /** 账户读取的发出序号与已采纳的最晚序号（见 fetchAccounts）。 */
  private accountsIssued = 0;
  private accountsApplied = 0;
  /** 全局设置与侧栏固定读取的发出序号与已采纳的最晚序号（见 fetchSettings、fetchPins）。 */
  private settingsIssued = 0;
  private settingsApplied = 0;
  private pinsIssued = 0;
  private pinsApplied = 0;
  /**
   * 最近一次写入的当前实例，以及写入发出时设置读取已发出到第几次（见 selectInstance、fetchSettings）。
   * 写入没有返回整份配置，晚到的旧读取不能整份丢掉（里面可能有改设置之后读到的别的字段），只把当前实例按写入改正。
   */
  private selectionWrite: { id: string; readsIssued: number } | null = null;
  private failureBatch: { toastId: string; startedAt: number; reasons: string[] } | null = null;
  private renameSeq = 0;
  /** 这次运行里落盘过的改名，按先后：等着 IPC 的流程把手里的 id 跟到现在的名字（见 renamedSince）。 */
  private readonly renames: { from: string; to: string }[] = [];
  /**
   * 任务日志读没读出来。unread 期间（首查进行中，或读失败、还可能读出来）不写回：写回会用内存里的表覆盖那份没读到的历史。
   * invalid 是文件损坏或版本不符，内容本来就救不回来，照常写回，免得任务表从此再也存不下来。
   */
  private journalState: "unread" | "read" | "invalid" = "unread";
  /** 最近一次写任务日志用的序号；读到日志后从盘上那份的序号之后接着编（见 saveJournal）。 */
  private journalSeq = 0;
  /** 首次启动向导的第一步已经提交（后端已记下向导完成）。 */
  private firstRunCommitted = false;
  /**
   * 已请求取消、还没落定的尝试（attemptTaskId）。后端只记「取消时不在运行」的 id：组合任务的某一项在取消宽限期内
   * 照常做完时按成功返回，同一个 id 再登记拿到的是全新的令牌，下一项会照常开始。所以取消要由前端记着，每开始一项前查一次。
   */
  private readonly cancelRequested = new Set<string>();
  /** 运行中组合任务的进度游标（按 attemptTaskId）：它的下载进度按整体折算，见 CompositeProgress。 */
  private readonly composites = new Map<string, CompositeProgress>();
  /**
   * 实例正在被删除、完成后不再落地的任务（任务 id）。删除前取消它们，但取消可能没赶上：任务在取消宽限期内照常做完时，
   * 写封面、写固定、弹「已就绪」都是对一个马上要删掉的实例做的，提示也会和结果对不上。
   */
  private readonly discardLanding = new Set<string>();
  /** 固定服务器的读改写排成一条链：两次切换并发时，后一次要等前一次写完再读，否则先写的那台会被后写的覆盖。 */
  private serverPinChain: Promise<void> = Promise.resolve();
  /**
   * 侧栏固定的读改写同样排成一条链：每一次都按 raw.pins 算出整份新列表写回，前一次还没写完时读到的是旧列表，
   * 两次固定、或装好的新实例落地自动固定撞上用户取消固定，后写的会把先写的那一项冲掉。
   */
  private sidebarPinChain: Promise<void> = Promise.resolve();
  /**
   * 实例设置只能整份写入，改一项要先读出整份再写回。设置页连着改两项（或装好的 Java 落地固定、崩溃页一键调内存撞上
   * 用户在改设置）时，两次都读到改前的那份，后写的会把先写的那一项冲回去。所以同一实例（键不分大小写）的读改写排成一条链。
   */
  private readonly settingsChains = new Map<string, Promise<void>>();

  readonly actions: LauncherActions;
  private readonly net: NetworkMonitor;
  private unobserveResources: (() => void) | null = null;

  /** network 供测试注入；应用里用全应用唯一的联网状态。 */
  constructor(options: { network?: NetworkMonitor } = {}) {
    this.net = options.network === undefined ? appNetwork : options.network;
    this.actions = observeFailures(this.createActions(), (error) => this.net.reportFailure(error));
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): LauncherState => {
    if (this.view === null || this.viewOf !== this.raw) {
      this.view = this.deriver.derive(this.raw);
      this.viewOf = this.raw;
    }
    return this.view;
  };

  private set(patch: Partial<RawState> | ((raw: RawState) => Partial<RawState>)): void {
    const next = typeof patch === "function" ? patch(this.raw) : patch;
    const before = this.raw;
    const merged = { ...this.raw, ...next };
    // 任务只会经任务表与 landing 离开，它们变了才核对挂在任务 id 上的记录
    this.raw = next.tasks !== undefined || next.landing !== undefined ? { ...merged, ...prunedTaskRefs(merged) } : merged;
    if (next.toasts !== undefined && next.toasts !== before.toasts) this.scheduleToastExpiry();
    if (next.session !== undefined && next.session !== before.session) this.scheduleLinger();
    for (const listener of [...this.listeners]) listener();
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 建立事件订阅；第一次订阅就绪后加载初始数据。可重复调用（StrictMode 的卸载再挂载），数据只加载一次。
   * 每次 start 是新的一代：上一代的订阅晚于 stop 才就绪时直接撤销，不会和这一代的订阅叠成两份。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    const gen = ++this.subscriptionGen;
    const subscriptions = [
      tasksIpc.onCoreEvent((e) => this.onCoreEvent(e)),
      accountsIpc.onDeviceCode((code) => this.onDeviceCode(code)),
      launchIpc.onLaunchPhase((e) => this.onLaunchPhase(e)),
      launchIpc.onGameLog((e) => this.onGameLog(e)),
      launchIpc.onGameExit((e) => this.onGameExit(e)),
      launchIpc.onWorldBackup((e) => this.onWorldBackup(e)),
    ];
    for (const sub of subscriptions) {
      sub.then(
        (unlisten) => {
          if (this.disposed || gen !== this.subscriptionGen) unlisten();
          else this.unlisteners.push(unlisten);
        },
        (error: unknown) => this.report(ACTION_ERROR.subscribe, error),
      );
    }
    window.addEventListener("focus", this.onWindowFocus);
    this.net.start({ onRecovered: () => this.announceRecovered(), onProbeError: (error) => this.report(ACTION_ERROR.probeNetwork, error) });
    this.unobserveResources = resources.observeErrors((error) => this.net.reportFailure(error));
    void Promise.allSettled(subscriptions).then(() => {
      // 先订阅再首查：首查期间到达的事件不会漏掉
      if (this.booted || this.disposed || gen !== this.subscriptionGen) return;
      this.booted = true;
      void this.boot();
    });
  }

  stop(): void {
    this.started = false;
    this.disposed = true;
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    window.removeEventListener("focus", this.onWindowFocus);
    this.net.stop();
    if (this.unobserveResources !== null) this.unobserveResources();
    this.unobserveResources = null;
    for (const timer of [this.toastTimer, this.lingerTimer, this.deviceTimer]) if (timer !== null) clearTimeout(timer);
    this.toastTimer = null;
    this.lingerTimer = null;
    this.deviceTimer = null;
  }

  private async boot(): Promise<void> {
    await Promise.all([
      this.loadSlice("settings"),
      this.loadSlice("accounts"),
      this.loadSlice("instances"),
      this.loadSlice("pins"),
      this.loadSlice("tasks"),
      this.loadSlice("firstRun"),
    ]);
  }

  private setStatus(slice: Slice, status: SliceStatus): void {
    this.set((raw) => ({ status: { ...raw.status, [slice]: status } }));
  }

  /** 加载一个切片；失败记进该切片的状态（页面原位呈现）并发一条通知，不往外抛。 */
  private async loadSlice(slice: Slice): Promise<void> {
    this.setStatus(slice, { kind: "loading" });
    const loaders: Record<Slice, () => Promise<void>> = {
      settings: () => this.fetchSettings(),
      accounts: () => this.fetchAccounts(),
      instances: () => this.fetchInstances(),
      pins: () => this.fetchPins(),
      tasks: () => this.fetchJournal(),
      firstRun: async () => this.set({ firstRun: await isFirstRun() }),
    };
    await loaders[slice]().then(
      () => this.setStatus(slice, { kind: "ready" }),
      (raw: unknown) => {
        const error = raw instanceof Error ? raw : new Error(String(raw));
        this.setStatus(slice, { kind: "error", error });
        this.report(BOOT_SLICE_ERROR[slice], error);
      },
    );
  }

  /**
   * 读全局设置。启动加载、改设置、换游戏目录、删除与改名都会读，先发出的那次可能后回来，读到的是更早的配置，
   * 照单采纳会把当前实例等设置改回去：与实例重扫一样只采纳比已采纳的那次更晚发出的结果。
   */
  private async fetchSettings(): Promise<void> {
    const seq = ++this.settingsIssued;
    const read = settingsFromDto(await configIpc.getConfig());
    if (seq <= this.settingsApplied) return;
    this.settingsApplied = seq;
    // 当前实例写入发出之前发出的读取可能读在写入之前
    const written = this.selectionWrite;
    const settings = written !== null && seq <= written.readsIssued ? { ...read, selectedVersion: written.id } : read;
    this.set({ settings });
  }

  /**
   * 读账户列表与当前账户。两条命令各自进后端的账户库锁，中间夹着另一路的增删时，读出的当前账户可能不在读出的列表里
   * （activeAccount 据此抛错，账户页与标题栏渲染失败）：对不上就重读，连着几次都对不上才报错。几处会同时发起读取
   * （启动加载、账户动作落定），先发出的那次可能后回来，所以与实例重扫一样只采纳比已采纳的那次更晚发出的结果。
   */
  private async fetchAccounts(): Promise<void> {
    const seq = ++this.accountsIssued;
    for (let attempt = 1; ; attempt += 1) {
      const [list, current] = await Promise.all([accountsIpc.listAccounts(), accountsIpc.currentAccount()]);
      if (current === null || list.some((a) => a.uuid === current.uuid)) {
        if (seq > this.accountsApplied) {
          this.accountsApplied = seq;
          this.set({ accounts: list.map(accountFromDto), currentAccountId: current === null ? null : current.uuid });
        }
        return;
      }
      if (attempt === ACCOUNT_READ_ATTEMPTS) throw new Error(`当前账户 ${current.uuid} 不在账户列表里，连读 ${ACCOUNT_READ_ATTEMPTS} 次都对不上`);
    }
  }

  /**
   * 重扫实例列表。几处会同时发起重扫（窗口获得焦点、游戏退出、任务落地、删除与改名），先发出的那次可能后回来：
   * 它读的是更早的盘面，照单采纳会让刚删掉的实例回到列表、刚改名的实例变回旧名。所以只采纳比已采纳的那次更晚发出的结果；
   * 晚到的旧结果丢掉，但 extra（撤占位项）照样套在已采纳的那份更新的列表上。
   */
  private async fetchInstances(extra?: (raw: RawState) => Partial<RawState>): Promise<void> {
    const seq = ++this.scanIssued;
    const dtos: InstanceDto[] = await instancesIpc.listInstances();
    const fresh = seq > this.scanApplied;
    if (fresh) {
      this.scanApplied = seq;
      this.lastScanAt = Date.now();
    }
    const scanned = fresh ? { scanned: dtos.map((dto) => instanceFromDto(dto, { pins: [], busyTaskInstanceIds: new Set() })) } : {};
    this.set((raw) => ({ ...scanned, ...(extra === undefined ? {} : extra(raw)) }));
  }

  /** 读侧栏固定。与 fetchSettings 同理，只采纳比已采纳的那次更晚发出的结果。 */
  private async fetchPins(): Promise<void> {
    const seq = ++this.pinsIssued;
    const pins = await instancesIpc.getSidebarPins();
    if (seq <= this.pinsApplied) return;
    this.pinsApplied = seq;
    this.set({ pins });
  }

  /**
   * 写入侧栏固定并采纳后端返回的整份列表。写入发出之前已在路上的读取可能读在写入之前，晚到时会把刚写下的固定改回去，
   * 所以一并作废；写入发出之后才发出的读取照常按序号采纳。
   */
  private async writePins(pins: string[]): Promise<void> {
    const issuedBefore = this.pinsIssued;
    const written = await instancesIpc.setSidebarPins(pins);
    this.pinsApplied = Math.max(this.pinsApplied, issuedBefore);
    this.set({ pins: written });
  }

  /**
   * 读任务日志并恢复上次的任务：上次没完成的记为「关闭时中断」。日志读不出来时用户照样能入队，所以重试读取时
   * 内存里已有的任务优先，原样保留，只把日志里内存没有的那些并进来；读到过一次之后内存就是准的，再读不改任务表。
   */
  private async fetchJournal(): Promise<void> {
    const journal = await tasksIpc.loadTaskJournal().catch((error: unknown) => {
      if (isIpcError(error) && error.code === TASK_JOURNAL_INVALID_CODE) this.journalState = "invalid";
      throw error;
    });
    // 只往前不往回：日志读不出期间照常写回过的话，内存里的序号可能已经超过这次读到的
    this.journalSeq = Math.max(this.journalSeq, journal.seq);
    if (this.journalState === "read") return;
    const now = Date.now();
    const loaded = journal.tasks.map((record) => journalTask(taskFromRecord(record)));
    this.journalState = "read";
    let changed = false;
    this.set((raw) => {
      const inMemory = new Set(raw.tasks.map((t) => t.id));
      const previous = loaded.filter((t) => !inMemory.has(t.id));
      const restored = restoreJournal(previous, now);
      // 内存里的任务是日志读不出期间入队的，还没写进去过
      changed = raw.tasks.length > 0 || restored.some((t, i) => t !== previous[i]);
      return { tasks: trimHistory([...restored, ...raw.tasks]) };
    });
    if (changed) this.scheduleJournal();
  }

  private readonly onWindowFocus = (): void => {
    if (this.raw.status.instances.kind !== "ready") return;
    if (Date.now() - this.lastScanAt < INSTANCE_RESCAN_MIN_MS) return;
    this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
  };

  // ---------------------------------------------------------------- 错误与通知

  /** 后台工作的失败：没有调用方可抛，写控制台并发 error 通知。 */
  private report(title: string, error: unknown): void {
    console.error(title, error);
    this.pushToast("error", title, describeError(error));
    this.net.reportFailure(error);
  }

  /** 由离线转回在线：发「网络已恢复」；有失败的下载时正文写个数，操作为全部重试。 */
  private announceRecovered(): void {
    const failed = this.raw.tasks.filter((t) => t.status === "failed" && !awaitsManualFiles(t)).length;
    const copy = TOAST_COPY.networkRestored(failed);
    const action: ToastAction | undefined =
      failed === 0 ? undefined : { label: TOAST_COPY.retryAllAction, run: () => void this.actions.retryFailedTasks(), errorTitle: ACTION_ERROR.install };
    this.pushToast("info", copy.title, "body" in copy ? copy.body : undefined, action);
  }

  private background(title: string, work: Promise<unknown>): void {
    work.catch((error: unknown) => this.report(title, error));
  }

  private pushToast(tone: ToastTone, title: string, body?: string, action?: ToastAction): string {
    const input = { tone, title, ...(body === undefined ? {} : { body }), ...(action === undefined ? {} : { action }) };
    const { state, id } = pushToast(this.raw.toasts, input, Date.now());
    this.set({ toasts: state });
    return id;
  }

  private scheduleToastExpiry(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    const deadline = nextToastDeadline(this.raw.toasts);
    if (deadline === null) return;
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.set({ toasts: expireToasts(this.raw.toasts, Date.now()) });
    }, Math.max(0, deadline - Date.now()));
  }

  // ---------------------------------------------------------------- 查询辅助

  private instance(id: string): InstanceSummary {
    const found = this.getState().instances.find((i) => i.id === id);
    if (found === undefined) throw new Error(`实例 ${id} 不存在`);
    return found;
  }

  private instanceIds(): string[] {
    return this.getState().instances.map((i) => i.id);
  }

  private currentAccount(): Account | null {
    const id = this.raw.currentAccountId;
    if (id === null) return null;
    const account = this.raw.accounts.find((a) => a.uuid === id);
    if (account === undefined) throw new Error(`当前账户 ${id} 不在账户列表里`);
    return account;
  }

  private sessionActiveFor(instanceId: string): boolean {
    const s = this.raw.session;
    return s !== null && s.instanceId === instanceId && isSessionActive(s);
  }

  /**
   * 实例里的 Mod 变了：该实例的列表、历史、可更新项与安装计划失效。发现页的落位矩阵按「装没装、装的哪一版」判定可装与否，
   * 它的 key 按工程而不是按实例划分，装上的前置也会改变别的工程的判定，所以整个 match 前缀一起失效。
   * 「已装入 n 个实例」一次读全部实例的已装来源，同样整个前缀失效。
   */
  private modsChanged(instanceId: string): void {
    for (const prefix of ["mods", "history", "mod-updates", "plan"]) invalidateResources(`${prefix}:${instanceId}`);
    invalidateResources("match");
    invalidateResources("installed-sources");
  }

  /** 改名已照成功落地，只差存档备份没挪过来：原因留在控制台，提示备份还在哪里，给出打开那个文件夹。 */
  private backupsLagged(name: string, err: IpcError): void {
    const path = strandedBackups(err);
    console.warn(err.message, err.detail);
    const copy = TOAST_COPY.backupsNotMoved(name, path);
    this.pushToast("warning", copy.title, copy.body, { label: TOAST_COPY.openFolderAction, run: () => this.actions.revealPath(path), errorTitle: ACTION_ERROR.openFolder });
  }

  /** 改名、删除已照成功落地，只差游玩记录：原因留在控制台，提示玩家记录之后会补上。 */
  private playRecordsLagged(name: string, err: IpcError): void {
    console.warn(err.message, err.detail);
    const copy = TOAST_COPY.playRecordsLagging(name);
    this.pushToast("warning", copy.title, copy.body);
  }

  /** Mod 文件操作的锁：运行中（含加载中）JVM 占着文件，安装中任务在写目录。界面已禁用入口，这里是第二道防线。 */
  private assertModsEditable(instanceId: string): void {
    if (this.sessionActiveFor(instanceId)) throw new Error(`「${instanceId}」的游戏正在运行，Mod 文件被占用`);
    if (this.instance(instanceId).status === "installing") throw new Error(`「${instanceId}」正在补全文件`);
  }

  // ---------------------------------------------------------------- 事件

  private onCoreEvent(event: CoreEvent): void {
    // 不带 task_id 的事件属于启动会话或非任务命令（离线用户名告警）；启动的进度走 launch-phase，日志走 game-log
    if (event.task_id === null) return;
    if (event.kind === "download") {
      const attemptId = event.task_id;
      const snapshot: DownloadSnapshot = { total: event.total, finished: event.finished, bytes: event.bytes, totalBytes: event.total_bytes, speed: event.speed };
      const cursor = this.composites.get(attemptId);
      if (cursor === undefined) {
        this.set((raw) => ({ tasks: applyTaskDownload(raw.tasks, attemptId, snapshot) }));
        return;
      }
      // 组合任务的每一项都带着序号调用，后端把它标在每条事件上；缺了说明约定破了，按快照去猜正是要消灭的误判
      if (event.step === undefined) throw new Error(`组合任务 ${attemptId} 收到了不带项序号的进度`);
      const next = applyCompositeDownload(this.raw.tasks, attemptId, cursor, event.step, snapshot);
      if (next === null) return;
      this.composites.set(attemptId, next.cursor);
      this.set({ tasks: next.tasks });
      return;
    }
    if (event.kind === "warning") {
      const task = taskByAttempt(this.raw.tasks, event.task_id);
      console.warn(`任务 ${task === undefined ? event.task_id : task.title} 的提醒：${event.message}`);
    }
  }

  private onDeviceCode(code: accountsIpc.DeviceCode): void {
    const login = this.raw.login;
    if (login === null || login.kind !== "microsoft") return;
    if (login.device.status !== "requesting" && login.device.status !== "waiting") return;
    this.clearDeviceTimer();
    const device: DeviceLogin = {
      status: "waiting",
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: Date.now() + code.expires_in * 1000,
      intervalSec: code.interval,
    };
    this.set({ login: { ...login, device } });
  }

  private onLaunchPhase(event: launchIpc.LaunchPhaseEvent): void {
    const s = this.raw.session;
    if (s === null) return;
    const next = applyPhase(
      s,
      {
        taskId: event.task_id,
        phase: event.phase,
        stageIndex: event.stage_index,
        download: event.download === undefined ? null : sessionDownloadFromDto(event.download),
      },
      Date.now(),
    );
    if (next !== s) this.set({ session: next });
  }

  private onGameLog(event: launchIpc.GameLogEvent): void {
    const s = this.raw.session;
    if (s === null) return;
    const next = appendSessionLogs(s, event.version_id, event.lines.map(logLineFromDto));
    if (next !== s) this.set({ session: next });
  }

  private onGameExit(event: launchIpc.GameExitEvent): void {
    const id = event.version_id;
    const s = this.raw.session;
    let crashedSession = false;
    if (s !== null && s.instanceId === id && isSessionActive(s)) {
      const next = sessionExited(s, { versionId: id, crashed: event.crashed, killed: event.killed }, Date.now());
      this.set({ session: next });
      crashedSession = next.phase === "crashed";
    }
    // 游玩时长、上次游玩与崩溃报告在推送前已由后端写好。这一局可能新建了存档，游玩统计也多了一段：
    // 没人订阅的缓存条目随之丢弃，之后重新挂载的页面会重取，不靠页面自己观察签名变化
    invalidateResources(`log:${id}`);
    invalidateResources(`content:${id}`);
    invalidateResources("play-stats");
    this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    if (crashedSession || (event.crashed && !event.killed)) this.background(ACTION_ERROR.loadCrash, this.announceCrash(id));
  }

  /**
   * 游戏退出后的自动备份做完了：备份列表与实例的活动（后端在备份期间记着 backing_up）都要重读。
   * 有存档没备份成时发一条 error 通知，正文是第一个失败存档的原文，「复制错误原文」带上全部失败与结构化详情。
   */
  private onWorldBackup(event: launchIpc.WorldBackupEvent): void {
    invalidateResources(WORLD_BACKUPS_RESOURCE);
    this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    const first = event.failed[0];
    if (first === undefined) return;
    for (const failure of event.failed) console.error(`「${event.instance_id}」的存档 ${failure.world} 自动备份没有完成`, failure.error);
    const raw = event.failed
      .map((f) => `${f.world}：${f.error.message}${f.error.detail === undefined ? "" : `\n${JSON.stringify(f.error.detail)}`}`)
      .join("\n");
    const copy = TOAST_COPY.autoBackupFailed(event.instance_id, first.error.message);
    this.pushToast("error", copy.title, copy.body, { label: TOAST_COPY.copyErrorAction, run: () => navigator.clipboard.writeText(raw), errorTitle: TOAST_COPY.copyFailed });
  }

  /** 读崩溃报告的主线索，写进会话并发崩溃通知。读不出时会话标为 unavailable，错误照常抛出。 */
  private async announceCrash(instanceId: string): Promise<void> {
    invalidateResources(`crash:${instanceId}`);
    // 读报告期间落盘的改名：这时通知还不存在，migrateRenamed 迁不到它，发的时候按当下的名字来
    const mark = this.renames.length;
    const current = () => this.renamedSince(instanceId, mark);
    const toCrashPage = (): ToastAction => ({ label: TOAST_COPY.viewCrashAction, to: { page: "instance", id: current(), tab: "crash" } });
    const setClue = (crash: SessionCrash) => {
      const s = this.raw.session;
      if (s !== null) this.set({ session: sessionCrashClue(s, current(), crash) });
    };
    const report = await resources.read(`crash:${instanceId}`, () => lastCrash(instanceId)).catch((error: unknown) => {
      setClue({ status: "unavailable" });
      this.pushToast("error", TOAST_COPY.crashed(current()), undefined, toCrashPage());
      throw error;
    });
    let category: CrashCategoryName | null = null;
    if (report !== null && report.diagnoses.length > 0) {
      const first = report.diagnoses[0].category;
      if (!isCrashCategory(first)) throw new Error(`未知的崩溃诊断类别：${first}`);
      category = first;
    }
    setClue(report === null ? { status: "unavailable" } : { status: "known", category });
    const body = category === null ? SESSION_COPY.noClue : SESSION_COPY.crashClue(crashCategoryLabel(category));
    this.pushToast("error", TOAST_COPY.crashed(current()), body, toCrashPage());
  }

  // ---------------------------------------------------------------- 会话计时

  private scheduleLinger(): void {
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    const s = this.raw.session;
    if (s === null || s.phase !== "stopped") return;
    const taskId = s.taskId;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      const cur = this.raw.session;
      if (cur !== null && cur.taskId === taskId && cur.phase === "stopped") this.set({ session: null });
    }, Math.max(0, s.phaseSince + STOPPED_LINGER_MS - Date.now()));
  }

  private waitSessionEnd(taskId: string): Promise<void> {
    return waitUntil(
      this.subscribe,
      () => {
        const s = this.raw.session;
        return s === null || s.taskId !== taskId || !isSessionActive(s);
      },
      STOP_TIMEOUT_MS,
      () => new Error(`${STOP_TIMEOUT_MS / 1000} 秒内游戏进程没有结束`),
    );
  }

  // ---------------------------------------------------------------- 下载任务

  private enqueue(draft: Omit<TaskDraft, "id">, meta: TaskMeta | null, subject: string): Task | null {
    const duplicate = findDuplicate(this.raw.tasks, draft.spec);
    if (duplicate !== undefined) {
      this.pushToast("info", TASK_TOAST.duplicate(subject).title);
      return null;
    }
    if (!TASK_COMMANDS.has(draft.spec.command)) throw new Error(`不是可排队的命令：${draft.spec.command}`);
    const task = newTask({ ...draft, id: freshId("task") }, Date.now());
    this.set((raw) => ({
      tasks: [...raw.tasks, task],
      taskMeta: meta === null ? raw.taskMeta : { ...raw.taskMeta, [task.id]: meta },
    }));
    this.tasksChanged();
    return task;
  }

  /**
   * 取消一个实例上的全部活动任务，等它们都落了结局再返回（删除实例前用）。
   * 排队的先一次性标为取消，再取消运行中的：反过来的话，运行中的一结束就空出通道，同实例排队的下一个会被立即拉起。
   * 排队的取消不逐条发通知，删除完成的那条通知已经交代了结果；运行中的仍按命令返回 cancelled 的常规路径落态。
   */
  private async cancelInstanceTasks(instanceId: string): Promise<void> {
    const pending = this.raw.tasks.filter((t) => isActiveTask(t) && t.instanceId === instanceId);
    if (pending.length === 0) return;
    const now = Date.now();
    this.set((raw) => ({
      tasks: trimHistory(pending.reduce((tasks, t) => (t.status === "queued" ? markCancelled(tasks, t.id, now) : tasks), raw.tasks)),
    }));
    this.tasksChanged();
    const ids = new Set(pending.map((t) => t.id));
    await Promise.all(this.raw.tasks.filter((t) => ids.has(t.id) && t.status === "running").map((t) => this.requestCancel(t)));
    await waitUntil(
      this.subscribe,
      () => !this.raw.tasks.some((t) => ids.has(t.id) && isActiveTask(t)),
      STOP_TIMEOUT_MS,
      () => new Error(`「${instanceId}」的 ${pending.length} 个任务没能及时取消`),
    );
  }

  /** 任务表变化后：防抖写日志、调度空出来的通道。 */
  private tasksChanged(): void {
    this.scheduleJournal();
    this.pump();
  }

  private scheduleJournal(): void {
    if (this.journalTimer !== null) clearTimeout(this.journalTimer);
    this.journalTimer = setTimeout(() => {
      this.journalTimer = null;
      this.background(ACTION_ERROR.saveJournal, this.saveJournal());
    }, TASK_JOURNAL_DEBOUNCE_MS);
  }

  private async saveJournal(): Promise<void> {
    if (this.journalState === "unread") return;
    // 序号与表在同一步取：序号大的那份一定是更新的表，防抖写入与关窗前的立即写入并发时后端据此丢掉晚到的旧表
    const seq = ++this.journalSeq;
    await tasksIpc.saveTaskJournal(seq, this.raw.tasks.map(taskToRecord));
  }

  private pump(): void {
    for (const task of tasksToStart(this.raw.tasks, sharedSavesKeys(this.raw.scanned))) {
      this.set((raw) => ({ tasks: markRunning(raw.tasks, task.id, Date.now()) }));
      const attempt = task.attempt;
      const attemptId = attemptTaskId(task);
      this.execute(task).then(
        (result) => {
          this.cancelRequested.delete(attemptId);
          this.composites.delete(attemptId);
          this.onTaskDone(task.id, attempt, result);
        },
        (error: unknown) => {
          this.cancelRequested.delete(attemptId);
          this.composites.delete(attemptId);
          this.onTaskFailed(task.id, attempt, error);
        },
      );
    }
  }

  /** 请后端取消运行中的这一次尝试，并记下请求：组合任务据此不再开始下一项。返回后端此刻是否在运行它。 */
  private requestCancel(task: Task): Promise<boolean> {
    const attemptId = attemptTaskId(task);
    this.cancelRequested.add(attemptId);
    return tasksIpc.cancelTask(attemptId);
  }

  /**
   * 逐项执行组合任务：每开始一项前查一次取消（见 cancelRequested），进度按各项的声明大小折成整体（见 CompositeProgress）。
   * 每一项拿到自己的序号（从 0 计），调后端命令时带上，它的进度事件据此归到这一项。
   * 游标留到这一次尝试落定才清：最后一项做完到任务落为完成之间晚到的进度也按组合任务的口径记账，不会把进度条拉回单项。
   */
  private async runSteps(attemptId: string, steps: readonly { size: number | null; run: (step: number) => Promise<unknown> }[]): Promise<void> {
    const start = compositeProgress(steps.map((step) => step.size));
    this.composites.set(attemptId, start);
    this.set((raw) => ({ tasks: startComposite(raw.tasks, attemptId, start) }));
    for (const [index, step] of steps.entries()) {
      if (this.cancelRequested.has(attemptId)) throw new IpcError(CANCELLED_ERROR_CODE, "已取消");
      await step.run(index);
      const cursor = this.composites.get(attemptId);
      if (cursor === undefined) throw new Error(`组合任务 ${attemptId} 的进度游标不见了`);
      const next = completeCompositeStep(this.raw.tasks, attemptId, cursor);
      this.composites.set(attemptId, next.cursor);
      this.set({ tasks: next.tasks });
    }
  }

  private async execute(task: Task): Promise<unknown> {
    const taskId = attemptTaskId(task);
    const { command, args } = task.spec;
    if (!TASK_COMMANDS.has(command)) throw new Error(`任务日志里有不可重放的命令：${command}`);
    // 组合任务逐个调后端命令，复用同一个 taskId
    if (command === "install_mods") {
      const versionId = strArg(args, "versionId", command);
      const skipped: string[] = [];
      try {
        await this.runSteps(
          taskId,
          modItems(args).map((item) => ({
            size: item.fileSize,
            run: async (step) => {
              const outcome = await installMod(taskId, versionId, item.platform, item.projectId, item.modVersionId, step);
              skipped.push(...outcome.skipped);
            },
          })),
        );
      } catch (error) {
        if (args.starter === true) this.reportSkippedDeps(task.id, versionId, skipped);
        throw error;
      }
      const outcome: InstallsOutcome = { skipped };
      return outcome;
    }
    if (command === "update_mods") {
      const versionId = strArg(args, "versionId", command);
      const items = task.attempt > 1 ? await this.pendingUpdates(versionId, updateItems(args)) : updateItems(args);
      const updated: UpdateItem[] = [];
      const skipped: string[] = [];
      try {
        await this.runSteps(
          taskId,
          items.map((item) => ({
            size: item.fileSize,
            run: async (step) => {
              const outcome = await modsIpc.updateMod(taskId, versionId, item.fileName, item.modVersionId, step);
              updated.push(item);
              skipped.push(...outcome.skipped);
            },
          })),
        );
      } catch (error) {
        // 停在中途时前面几项已经换好：失败与取消的通知只说这次停了，它们没有照办的前置要在这里说
        this.reportSkippedDeps(task.id, versionId, skipped);
        throw error;
      }
      const outcome: UpdatesOutcome = { updated, skipped };
      return outcome;
    }
    // starterMods 只供前端在重启后恢复「就绪后接着装」，后端的新建与补全命令没有这个参数，不往下传
    const wire: Record<string, unknown> = { ...args, taskId };
    delete wire.starterMods;
    return invoke<unknown>(command, wire);
  }

  /**
   * 重试「全部更新」时，上一次尝试里已经换过的不再更新：更新会把文件换成新版本的文件名，按原文件名再调一次只会失败。
   * 按工程重新对一遍：已经是目标版本的、或者 Mod 已被移除不再有更新的跳过，其余用它现在的文件名。
   */
  private async pendingUpdates(versionId: string, items: UpdateItem[]): Promise<UpdateItem[]> {
    const candidates = await modsIpc.checkUpdates(versionId);
    return items.flatMap((item) => {
      const current = candidates.find((c) => c.latest.platform === item.platform && c.latest.project_id === item.projectId);
      if (current === undefined || current.current_version_id === item.modVersionId) return [];
      return [{ ...item, fileName: current.file_name }];
    });
  }

  /**
   * 更新不走确认计划，新版本要的必需前置没有照办时玩家没有别处可知：补一条通知，并把全文记进任务详情。
   * 通知正文最多三行、还会消失，全文要到下载任务页去看。几项撞上同一个前置时只说一次。
   */
  private reportSkippedDeps(taskId: string, instanceId: string, skipped: readonly string[]): void {
    const notes = [...new Set(skipped)];
    if (notes.length === 0) return;
    const copy = TASK_TOAST.updateDepsSkipped(instanceId, notes);
    this.set((raw) => ({ tasks: raw.tasks.map((t) => (t.id === taskId ? { ...t, detail: TASK_TEXT.updateDetailWithDeps(t.detail, copy.body) } : t)) }));
    this.scheduleJournal();
    this.pushToast("warning", copy.title, copy.body, { label: TASK_TOAST.viewAction, to: { page: "tasks" } });
  }

  private findTask(id: string): Task {
    const task = this.raw.tasks.find((t) => t.id === id);
    if (task === undefined) throw new Error(`没有任务 ${id}`);
    return task;
  }

  private metaOf(task: Task): TaskMeta | null {
    const meta = this.raw.taskMeta[task.id];
    return meta === undefined ? metaFromSpec(task) : meta;
  }

  /**
   * 重试时补上入队上下文：重启后恢复的任务没有它，而实例列表的占位项、结束时留占位到重扫落定、装好后自动固定都只认
   * taskMeta。不补的话，重试上次关闭时中断的新建或导入，安装期间实例不在列表里，任务行的「查看实例」也无处可去。
   */
  private restoredMeta(raw: RawState, task: Task): Partial<RawState> {
    if (raw.taskMeta[task.id] !== undefined) return {};
    const meta = metaFromSpec(task);
    return meta === null ? {} : { taskMeta: { ...raw.taskMeta, [task.id]: meta } };
  }

  private onTaskDone(id: string, attempt: number, result: unknown): void {
    const before = this.findTask(id);
    if (before.status !== "running" || before.attempt !== attempt) return;
    const keep = this.keepsPlaceholder(before);
    this.set((raw) => ({ tasks: trimHistory(markDone(raw.tasks, id, attempt, Date.now())), ...(keep ? { landing: [...raw.landing, id] } : {}) }));
    this.tasksChanged();
    this.rescanHeld(before.instanceId);
    if (this.discardLanding.has(id)) return;
    this.background(
      ACTION_ERROR.landTask(before.title),
      this.landTask(before, result).finally(() => this.endLanding(id)),
    );
  }

  /**
   * 任务进行中的重扫把后端当时的占用记进了列表，派生时留着它。任务结束时后端已放开，有的任务落地时不重扫（更新 Mod、
   * 导出整合包），不重读的话改名、删除、补全一直按占用禁用到下一次重扫。落地也重扫的按序号采纳后一次，多扫一遍无妨。
   */
  private rescanHeld(instanceId: string | null): void {
    if (instanceId === null) return;
    const key = instanceId.toLowerCase();
    if (this.raw.scanned.some((i) => i.id.toLowerCase() === key && i.activity !== null)) this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
  }

  /** 新建与导入任务结束时它的占位项要留到落地重扫落定（见 RawState.landing）；用户正在删除它时不留。 */
  private keepsPlaceholder(task: Task): boolean {
    const meta = this.raw.taskMeta[task.id];
    return meta !== undefined && (meta.type === "create" || meta.type === "modpack") && !this.discardLanding.has(task.id);
  }

  private withoutLanding(raw: RawState, taskId: string): Partial<RawState> {
    return raw.landing.includes(taskId) ? { landing: raw.landing.filter((id) => id !== taskId) } : {};
  }

  /** 落地重扫没走到（之前的步骤失败）或重扫本身失败时，占位项也不再留着。 */
  private endLanding(taskId: string): void {
    if (this.raw.landing.includes(taskId)) this.set((raw) => this.withoutLanding(raw, taskId));
  }

  private onTaskFailed(id: string, attempt: number, error: unknown): void {
    const before = this.findTask(id);
    if (before.status !== "running" || before.attempt !== attempt) return;
    const keep = this.keepsPlaceholder(before);
    const landing = (raw: RawState): Partial<RawState> => (keep ? { landing: [...raw.landing, id] } : {});
    if (isCancelled(error)) {
      this.set((raw) => ({ tasks: trimHistory(markCancelled(raw.tasks, id, Date.now())), ...landing(raw) }));
      this.pushToast("info", TASK_TOAST.cancelled(before.title).title);
    } else {
      console.error(`任务失败：${before.title}`, error);
      this.net.reportFailure(error);
      const record = failureRecord(error);
      this.set((raw) => ({
        tasks: trimHistory(markFailed(raw.tasks, id, attempt, record, Date.now())),
        unseenFailures: [...raw.unseenFailures, attemptTaskId(before)],
        ...landing(raw),
      }));
      if (WORLD_TASK_COMMANDS.has(before.spec.command)) this.worldFailureToast(before, taskFailureReason(record));
      else this.failureToast(before, record);
    }
    this.tasksChanged();
    this.rescanHeld(before.instanceId);
    // 恢复没做完时原来的存档可能已经进了回收站；备份失败也可能清掉了半截的临时文件。列表、存档与实例的活动都按盘上重读
    if (WORLD_TASK_COMMANDS.has(before.spec.command) && before.instanceId !== null) {
      invalidateResources(WORLD_BACKUPS_RESOURCE);
      invalidateResources(`content:${before.instanceId}`);
      this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    }
    // 新建与导入取消后后端删除实例，修复失败或取消后实例带着未完成标记，都要重扫。占位项与重扫结果在同一次
    // 更新里交接：盘上留了目录就由扫描项接替，没留就移除
    if (INSTANCE_TASK_COMMANDS.has(before.spec.command)) {
      this.background(
        ACTION_ERROR.refreshInstances,
        this.fetchInstances((raw) => this.withoutLanding(raw, id)).finally(() => this.endLanding(id)),
      );
    }
    // 组合任务停下之前做完的那几项已经落盘，Mod 列表与数目不能停在任务开始前
    if (COMPOSITE_TASKS.has(before.spec.command) && before.instanceId !== null) {
      this.modsChanged(before.instanceId);
      this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    }
  }

  /** 备份、导出、恢复存档失败：各自一条，不并进下载失败的合并通知（它们不是下载）。 */
  private worldFailureToast(task: Task, reason: string): void {
    const copy = TASK_TOAST.worldFailed(task.title, reason);
    this.pushToast("error", copy.title, copy.body, { label: TASK_TOAST.retryAction, run: () => this.actions.retryTask(task.id), errorTitle: ACTION_ERROR.install });
  }

  /**
   * 单个失败一条「下载失败」；10 s 内再有失败合并成一条「n 个下载失败」，操作改为查看失败筛选。
   * 导出整合包不是下载：它的失败单独一条「导出失败」，不并进也不开启下载失败的合并。
   */
  private failureToast(task: Task, error: TaskError): void {
    const reason = taskFailureReason(error);
    const now = Date.now();
    if (task.kind === "modpack_export") {
      const copy = TASK_TOAST.exportFailed(task.title, reason);
      this.pushToast("error", copy.title, copy.body, { label: TASK_TOAST.retryAction, run: () => this.actions.retryTask(task.id), errorTitle: ACTION_ERROR.exportModpack });
      return;
    }
    const batch = this.failureBatch;
    if (batch !== null && now - batch.startedAt <= FAILURE_TOAST_MERGE_MS) {
      this.set({ toasts: dismissToast(this.raw.toasts, batch.toastId) });
      const reasons = [...batch.reasons, reason];
      const merged = TASK_TOAST.failedMany(reasons.length, reasons);
      const toastId = this.pushToast("error", merged.title, merged.body, { label: TASK_TOAST.viewAction, to: { page: "tasks", filter: "failed" } });
      this.failureBatch = { toastId, startedAt: batch.startedAt, reasons };
      return;
    }
    const single = TASK_TOAST.failed(task.title, reason);
    // 文件没到手时重试必然再失败一次，通知上不给重试，转去失败筛选看清单
    const action: ToastAction =
      error.blocked_files === undefined
        ? { label: TASK_TOAST.retryAction, run: () => this.actions.retryTask(task.id), errorTitle: ACTION_ERROR.install }
        : { label: TASK_TOAST.viewAction, to: { page: "tasks", filter: "failed" } };
    const toastId = this.pushToast("error", single.title, single.body, action);
    this.failureBatch = { toastId, startedAt: now, reasons: [reason] };
  }

  private withRunningSuffix(instanceId: string, body: string): string {
    return this.sessionActiveFor(instanceId) ? `${body}${NEXT_LAUNCH_SUFFIX}` : body;
  }

  private launchAction(instanceId: string): ToastAction {
    return instanceAction(instanceId, (id) => ({ label: TASK_TOAST.launchAction, run: () => this.actions.launch(id), errorTitle: ACTION_ERROR.launch(id) }));
  }

  /** 新建、导入的实例：写封面；要固定且侧栏此刻没满时追加到固定列表末尾。重扫结果与撤下占位项在同一次更新里。 */
  private async settleNewInstance(taskId: string, id: string, cover: string | null, pin: boolean): Promise<void> {
    if (cover !== null) {
      await this.queueInstanceSettings(id, async () => {
        const current = instanceSettingsFromDto(await instancesIpc.getInstanceSettings(id));
        await instancesIpc.setInstanceSettings(id, instanceSettingsToDto({ ...current, cover }));
      });
    }
    if (pin) {
      await this.queueSidebarPins(async () => {
        const pins = this.raw.pins;
        if (pins.length < SIDEBAR_PIN_LIMIT && !pins.includes(id)) await this.writePins([...pins, id]);
      });
    }
    this.instanceIdTaken(id);
    await this.fetchInstances((raw) => this.withoutLanding(raw, taskId));
  }

  /** 排进侧栏固定的链（见 sidebarPinChain）：前一次落定后才开始；这一次的结果与失败照常交给调用方，不挡后面排着的。 */
  private queueSidebarPins<T>(work: () => Promise<T>): Promise<T> {
    const run = this.sidebarPinChain.then(work);
    this.sidebarPinChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 排进这个实例的设置读改写链（见 settingsChains）：前一次落定后才开始；这一次的结果与失败照常交给调用方，不挡后面排着的。
   * 链在排空时撤掉，不随用过的实例 id 越积越多。
   */
  private queueInstanceSettings<T>(id: string, work: () => Promise<T>): Promise<T> {
    const key = id.toLowerCase();
    const previous = this.settingsChains.get(key);
    const run = (previous === undefined ? Promise.resolve() : previous).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.settingsChains.set(key, settled);
    void settled.then(() => {
      if (this.settingsChains.get(key) === settled) this.settingsChains.delete(key);
    });
    return run;
  }

  /** 这个 id 落到了一个新实例上：丢掉之前用过这个 id 的实例留下的按需数据（见 INSTANCE_SCOPED_RESOURCES）。 */
  private instanceIdTaken(id: string): void {
    for (const prefix of INSTANCE_SCOPED_RESOURCES) invalidateResources(`${prefix}:${id}`);
  }

  /**
   * 改名已落盘：内存里挂在旧 id 上的引用一次迁到新 id，不等之后的重扫与读取（它们失败时任务重试、会话修复动作都还指着
   * 已经不在的旧名字）。实例列表里那一项就地改名、与 lastRename 在同一次更新里：外壳按 lastRename 改写历史、按实例列表
   * 剪路由，新 id 晚一帧进列表，实例页就被当成已删除剪掉。后端随改名迁了侧栏固定与当前实例，这里同样就地换掉；
   * 改名之前发出、还没回来的重扫与读取读的是改名前的盘面，晚到时不再采纳。
   */
  private migrateRenamed(from: string, to: string): void {
    this.scanApplied = this.scanIssued;
    this.pinsApplied = this.pinsIssued;
    this.settingsApplied = this.settingsIssued;
    this.renameSeq += 1;
    const seq = this.renameSeq;
    this.renames.push({ from, to });
    this.set((raw) => ({
      lastRename: { from, to, seq },
      scanned: raw.scanned.map((i) => (i.id === from ? { ...i, id: to, name: to } : i)),
      pins: raw.pins.map((p) => (p === from ? to : p)),
      settings: raw.settings === null || raw.settings.selectedVersion !== from ? raw.settings : { ...raw.settings, selectedVersion: to },
      tasks: raw.tasks.map((t) => renamedTask(t, from, to)),
      taskMeta: Object.fromEntries(Object.entries(raw.taskMeta).map(([taskId, meta]) => [taskId, renamedMeta(meta, from, to)])),
      // 已结束的失败、崩溃会话不算占用，允许改名；它的修复动作与「查看诊断」都按会话里的实例 id 走，必须一起迁过去
      session: raw.session !== null && raw.session.instanceId === from ? { ...raw.session, instanceId: to } : raw.session,
      toasts: retargetToasts(raw.toasts, from, to),
      login: renamedLogin(raw.login, from, to),
      launchPrompt:
        raw.launchPrompt === null
          ? null
          : {
              ...raw.launchPrompt,
              instanceId: raw.launchPrompt.instanceId === from ? to : raw.launchPrompt.instanceId,
              occupantId: raw.launchPrompt.occupantId === from ? to : raw.launchPrompt.occupantId,
            },
    }));
  }

  /** mark（当时的 renames.length）之后 id 改成了什么；没改过原样返回。 */
  private renamedSince(id: string, mark: number): string {
    return this.renames.slice(mark).reduce((cur, r) => (r.from === cur ? r.to : cur), id);
  }

  /** 还在安装、实例目录还没装好的新建实例：它的任务与入队上下文；不是这种实例为 null。 */
  private pendingCreate(id: string): { taskId: string; meta: Extract<TaskMeta, { type: "create" }> } | null {
    if (this.raw.scanned.some((i) => i.id === id)) return null;
    for (const task of this.raw.tasks) {
      if (!isActiveTask(task)) continue;
      const meta = this.raw.taskMeta[task.id];
      if (meta !== undefined && meta.type === "create" && meta.name === id) return { taskId: task.id, meta };
    }
    return null;
  }

  /** 任务完成后的落地与通知（任务完成一律弹，不论用户此时在哪一页）。 */
  private async landTask(task: Task, result: unknown): Promise<void> {
    const meta = this.metaOf(task);
    const command = task.spec.command;
    if (meta === null) {
      if (task.instanceId !== null) {
        this.modsChanged(task.instanceId);
        invalidateResources(`content:${task.instanceId}`);
        await this.fetchInstances();
      }
      this.pushToast("success", TASK_TOAST.finished(task.title).title);
      if (command === "update_mod") this.reportSkippedDeps(task.id, strArg(task.spec.args, "versionId", command), (result as modsIpc.ModUpdateOutcomeDto).skipped);
      return;
    }
    switch (meta.type) {
      case "create": {
        const outcome = result as InstallResultDto;
        const id = outcome.id;
        await this.settleNewInstance(task.id, id, meta.cover, meta.autoPin);
        const copy = TASK_TOAST.ready(id);
        this.pushToast("success", copy.title, copy.body, this.launchAction(id));
        // 勾选与否以任务参数为准：重启后恢复的任务没有入队时的上下文，参数里仍记着
        if (task.spec.args.useTemplate === true) {
          const template = outcome.template;
          if (template === null || template === undefined) throw new Error(`新建「${id}」请求了沿用默认设置，安装结果里却没有套用结果`);
          if (template.status === "skipped") {
            const skipped = TASK_TOAST.templateSkipped(id, template.reason);
            this.pushToast("info", skipped.title, skipped.body);
          }
        }
        if (meta.starter.length > 0) this.enqueueStarter(id, meta.starter);
        return;
      }
      case "modpack": {
        const id = (result as ModpackInstallOutcomeDto).version_id;
        await this.settleNewInstance(task.id, id, meta.cover, true);
        // 重启后恢复的导入任务不知道 Mod 数，正文省略
        const copy = TASK_TOAST.imported(id, meta.modCount);
        this.pushToast("success", copy.title, "body" in copy ? copy.body : undefined, this.launchAction(id));
        return;
      }
      case "repair": {
        const mark = this.renames.length;
        await this.fetchInstances();
        const id = this.renamedSince(strArg(task.spec.args, "id", command), mark);
        if (meta.starter.length > 0) this.enqueueStarter(id, meta.starter);
        if (meta.launchAfter && !isSessionActive(this.raw.session)) {
          await this.actions.launch(id);
          return;
        }
        this.dismissRepairedFailure(id);
        const copy = task.spec.args.reinstallLoader === true ? TASK_TOAST.loaderReinstalled(id) : TASK_TOAST.repaired(id);
        this.pushToast("success", copy.title, undefined, this.launchAction(id));
        return;
      }
      case "java": {
        const runtime = result as InstalledRuntimeDto;
        this.set((raw) => ({ tasks: raw.tasks.map((t) => (t.id === task.id ? { ...t, detail: TASK_TEXT.javaDetail(runtime.version.raw) } : t)) }));
        this.scheduleJournal();
        invalidateResources("java");
        const mark = this.renames.length;
        if (meta.pinFor !== null) await this.actions.updateInstanceSettings(meta.pinFor, { java: runtime.java_executable });
        const copy = meta.pinFor === null ? TASK_TOAST.java(meta.major) : TASK_TOAST.javaPinned(meta.major, this.renamedSince(meta.pinFor, mark));
        this.pushToast("success", copy.title, copy.body, meta.launchAfter === null ? undefined : this.launchAction(this.renamedSince(meta.launchAfter, mark)));
        return;
      }
      case "mods": {
        this.modsChanged(meta.instanceId);
        await this.fetchInstances();
        const copy = TASK_TOAST.modInstalled(meta.name, meta.dependencies, meta.instanceId);
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
        return;
      }
      case "starter": {
        this.modsChanged(meta.instanceId);
        await this.fetchInstances();
        this.pushToast("success", TASK_TOAST.starterInstalled(meta.instanceId, meta.count).title);
        // 发现页的安装在确认计划里已经列过，开局 Mod 没有这一步
        this.reportSkippedDeps(task.id, meta.instanceId, (result as InstallsOutcome).skipped);
        return;
      }
      case "resource": {
        const outcome = result as ResourceInstallOutcomeDto;
        invalidateResources(`content:${meta.instanceId}`);
        invalidateResources("match");
        const copy =
          outcome.resource_type === "resource_pack"
            ? TASK_TOAST.resourcePack(meta.name)
            : outcome.resource_type === "shader"
              ? TASK_TOAST.shader(meta.name, meta.instanceId)
              : outcome.resource_type === "data_pack"
                ? TASK_TOAST.datapack(meta.name, outcome.world)
                : TASK_TOAST.modInstalled(meta.name, 0, meta.instanceId);
        if (outcome.resource_type === "mod") {
          this.modsChanged(meta.instanceId);
          await this.fetchInstances();
        }
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
        return;
      }
      case "update": {
        this.modsChanged(meta.instanceId);
        const copy = TASK_TOAST.modUpdated(meta.name, meta.instanceId);
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
        this.reportSkippedDeps(task.id, meta.instanceId, (result as modsIpc.ModUpdateOutcomeDto).skipped);
        return;
      }
      case "updates": {
        // 重试时上一次尝试已经换掉的不再计入：通知只说这一次实际换了什么
        const { updated, skipped } = result as UpdatesOutcome;
        this.modsChanged(meta.instanceId);
        if (updated.length === 0) {
          const latest = TASK_TOAST.modsAlreadyLatest(meta.instanceId);
          this.pushToast("info", latest.title, latest.body);
          return;
        }
        const only = updated.length === 1 ? updated[0].title : null;
        const copy = only === null ? TASK_TOAST.modsUpdated(updated.length, meta.instanceId) : TASK_TOAST.modUpdated(only, meta.instanceId);
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
        this.reportSkippedDeps(task.id, meta.instanceId, skipped);
        return;
      }
      case "world": {
        // 共用存档的几个实例看到同一份备份表，整个前缀一起失效；恢复换掉了存档，存档列表跟着重读
        invalidateResources(WORLD_BACKUPS_RESOURCE);
        invalidateResources(`content:${meta.instanceId}`);
        const mark = this.renames.length;
        await this.fetchInstances();
        if (meta.op === "backup") {
          const outcome = result as BackupResultDto;
          const copy = TASK_TOAST.worldBackedUp(meta.name, outcome.backup.size_bytes, outcome.pruned);
          this.pushToast("success", copy.title, copy.body, { label: TASK_TOAST.viewBackupsAction, to: { page: "instance", id: this.renamedSince(meta.instanceId, mark), tab: "overview" } });
          return;
        }
        if (meta.op === "export") {
          const outcome = result as ExportResultDto;
          const copy = TASK_TOAST.worldExported(meta.name, outcome.path);
          this.pushToast("success", copy.title, copy.body, { label: TASK_TOAST.openContainingAction, run: () => this.actions.revealPath(outcome.path), errorTitle: ACTION_ERROR.openFolder });
          return;
        }
        const outcome = result as RestoreResultDto;
        const copy = TASK_TOAST.worldRestored(meta.name, outcome.previous_in_recycle_bin);
        this.pushToast("success", copy.title, "body" in copy ? copy.body : undefined);
        return;
      }
      case "export": {
        // 导出不改实例：没有要失效的缓存，也不追加「下次启动生效」
        const outcome = result as ModpackExportOutcomeDto;
        const copy = TASK_TOAST.exported(meta.name, outcome.bundled_mods.length);
        this.pushToast("success", copy.title, "body" in copy ? copy.body : undefined, {
          label: TASK_TOAST.revealAction,
          run: () => this.actions.revealPath(outcome.path),
          errorTitle: ACTION_ERROR.revealExport,
        });
        return;
      }
    }
  }

  /**
   * 新实例就绪后接着装开局 Mod：排一个组合任务，在下载任务里只占一行。它是实例之外的一步，失败照任务失败呈现，
   * 实例本身照常可用；重试时前面已经装上的几项后端认出已装、直接跳过。
   */
  private enqueueStarter(instanceId: string, starter: readonly StarterPick[]): void {
    const title = TASK_TEXT.starterTitle(starter.length);
    this.enqueue(
      {
        kind: "mod",
        title,
        detail: TASK_TEXT.starterDetail(instanceId),
        instanceId,
        spec: {
          command: "install_mods",
          args: {
            versionId: instanceId,
            platform: "modrinth",
            projectId: starter[0].projectId,
            starter: true,
            items: starter.map((pick) => ({ platform: "modrinth", projectId: pick.projectId, modVersionId: pick.modVersionId, title: pick.title, fileSize: pick.fileSize })),
          },
        },
      },
      { type: "starter", instanceId, count: starter.length },
      title,
    );
  }

  // ---------------------------------------------------------------- 登录内部

  private clearDeviceTimer(): void {
    if (this.deviceTimer !== null) clearTimeout(this.deviceTimer);
    this.deviceTimer = null;
  }

  private loginIntent(kind: LoginState["kind"]): LoginIntent {
    const login = this.raw.login;
    return login !== null && login.kind === kind ? login.intent : MANUAL_LOGIN;
  }

  /**
   * 登录或添加账户成功后关掉对应弹窗并发通知；由启动拦截触发的，通知正文改为「正在启动」并继续这次启动。
   * 只关同一种登录的弹窗：从向导等别处直接添加账户时，不误关此刻开着的其他登录弹窗。
   */
  private async afterAccountAdded(kind: LoginState["kind"], intent: LoginIntent, toast: { title: string; body?: string }): Promise<void> {
    if (this.raw.login !== null && this.raw.login.kind === kind) this.set({ login: null });
    if (intent.kind === "launch") {
      this.pushToast("success", toast.title, TOAST_COPY.continuingLaunch(intent.instanceId));
      await this.requestLaunch(intent.instanceId, intent.quickPlay);
      return;
    }
    this.pushToast("success", toast.title, toast.body);
  }

  // ---------------------------------------------------------------- 启动内部

  /**
   * 普通启动与直达共用的拦截链：同一实例已在加载或运行时直接返回；别的实例占着游戏进程时弹替换确认；
   * 安装中抛错；损坏的普通启动转成「修复并启动」，直达抛错；没有账户先登录，登录后带着同一个 quickPlay 继续。
   */
  private async requestLaunch(id: string, quickPlay: launchIpc.QuickPlayArg | null): Promise<void> {
    const inst = this.instance(id);
    const s = this.raw.session;
    if (s !== null && isSessionActive(s)) {
      // 同一实例在多个入口上点启动，只有第一次生效
      if (s.instanceId === id) return;
      this.set({ launchPrompt: { instanceId: id, occupantId: s.instanceId, occupantPhase: s.phase === "running" ? "running" : "loading", quickPlay } });
      return;
    }
    if (inst.status === "installing") throw new Error(`「${id}」还在安装，入口不应提供启动`);
    if (inst.status === "broken") {
      // 修复完成后的自动启动是普通启动，带不上直达目标：入口按损坏禁用直达
      if (quickPlay !== null) throw new Error(`「${id}」需要先修复，入口不应提供直达`);
      await this.actions.repairInstance(id, { launchAfter: true });
      return;
    }
    const account = this.currentAccount();
    if (account === null) {
      this.set({ login: { kind: "no_account", intent: { kind: "launch", instanceId: id, quickPlay } } });
      return;
    }
    await this.startLaunch(id, account, quickPlay, false);
  }

  /** offlineFallback：失败卡上的「以离线方式进单人」，这一局不刷新登录；能否放行由后端凭它记下的上一次失败判定。 */
  private async startLaunch(instanceId: string, account: Account, quickPlay: launchIpc.QuickPlayArg | null, offlineFallback: boolean): Promise<void> {
    const taskId = freshId("launch");
    this.set({ session: startSession(instanceId, taskId, account, Date.now(), quickPlay), launchPrompt: null });
    if (this.raw.settings !== null && this.raw.settings.selectedVersion !== instanceId) {
      this.background(ACTION_ERROR.selectInstance, this.actions.selectInstance(instanceId));
    }
    // 启动的结局（失败码、取消）是会话状态的一部分，不是异常：在这里转成会话；其余错误清掉乐观会话后原样抛出
    await launchIpc.launchGame({ taskId, versionId: instanceId, accountUuid: account.uuid, offlineName: null, offlineFallback, quickPlay }).then(
      (launched) => {
        const s = this.raw.session;
        if (s !== null) this.set({ session: sessionLaunched(s, taskId, Date.now()) });
        if (launched.offline) {
          const copy = TOAST_COPY.offlineLaunched(instanceId);
          this.pushToast("info", copy.title, copy.body);
        }
      },
      (error: unknown) => {
        this.net.reportFailure(error);
        const s = this.raw.session;
        if (s === null || s.taskId !== taskId) throw error;
        if (isCancelled(error)) {
          this.set({ session: sessionCancelled(s, taskId, Date.now()) });
          return;
        }
        if (isIpcError(error) && isFailureCode(error.code)) {
          this.failLaunch(s, error.code, error.detail);
          return;
        }
        // 登录已失效而被拒绝降级：失败卡改给「重新登录」；其余拒绝原因（离线账户、启动器重开后不记得上次的失败）交给外层
        const refusal = offlineFallback ? launchIpc.offlineFallbackRefusal(error) : null;
        if (refusal !== null && refusal.reason === "relogin_required") {
          this.failLaunch(s, "account_relogin", { account: refusal.account });
          return;
        }
        this.set({ session: null });
        // 直达的存档已被移走：入口手里的存档列表过时了，重读一遍，免得那一行留着让人再点
        if (quickPlay !== null && quickPlay.kind === "singleplayer" && isIpcError(error) && error.code === launchIpc.WORLD_NOT_FOUND_CODE) {
          invalidateResources(`content:${instanceId}`);
        }
        throw error;
      },
    );
  }

  /** 修好了失败横幅说的问题，横幅再留着就是过时的话。账户、网络这些修复管不到的失败下次启动还会撞上，留着。 */
  private dismissRepairedFailure(id: string): void {
    const s = this.raw.session;
    if (s === null || s.phase !== "failed" || s.instanceId !== id || s.failure === null) return;
    const { fix } = failureCopy(s.failure.code, s.failure.params, { accountName: s.accountName, accountKind: s.accountKind, javaPinned: false });
    if (fix.kind === "repair" || fix.kind === "reinstall_loader") this.set({ session: null });
  }

  private failLaunch(s: SessionState, code: FailureCode, detail: unknown): void {
    const params: Record<string, string | number> = {};
    if (typeof detail === "object" && detail !== null) {
      for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") params[key] = value;
      }
    }
    const failed = sessionFailed(s, s.taskId, { code, params }, Date.now());
    this.set({ session: failed });
    // 通知的操作是修复动作的第一个按钮。javaPinned 只影响第二个按钮，这里不读实例设置
    const copy = failureCopy(code, params, { accountName: s.accountName, accountKind: s.accountKind, javaPinned: false });
    const action = instanceAction(failed.instanceId, (instanceId) => ({ label: failureToastLabel(copy.fix), ...this.fixTarget({ ...failed, instanceId }, copy.fix.kind) }));
    this.pushToast("error", TOAST_COPY.launchFailed(s.instanceId), copy.title, action);
  }

  /** 启动失败的修复动作落到哪里：导航类给路由，命令类给要执行的函数。失败通知与启动入口共用这一份映射。 */
  private fixTarget(s: SessionState, kind: FailureFixKind): FailureFixTarget {
    const instanceId = s.instanceId;
    switch (kind) {
      case "retry": {
        // 重试、改为自动选择 Java 后立即重启、重新登录后继续，都是同一次启动再来一遍，直达目标一起带上；
        // 下载 Java 后的自动启动挂在下载任务上，按普通启动继续
        const quickPlay = s.quickPlay;
        return { run: () => this.requestLaunch(instanceId, quickPlay), errorTitle: ACTION_ERROR.launch(instanceId) };
      }
      case "repair":
        return { run: () => this.actions.repairInstance(instanceId), errorTitle: ACTION_ERROR.repair };
      case "reinstall_loader":
        return { run: () => this.actions.repairInstance(instanceId, { reinstallLoader: true }), errorTitle: ACTION_ERROR.reinstallLoader };
      case "download_java": {
        const major = s.failure === null ? undefined : s.failure.params.major;
        if (typeof major !== "number") throw new Error("java_missing 缺少 major");
        return { run: () => this.actions.installJava(major, { launchAfter: instanceId }), errorTitle: ACTION_ERROR.installJava };
      }
      case "auto_java": {
        const quickPlay = s.quickPlay;
        return {
          run: async () => {
            await this.actions.updateInstanceSettings(instanceId, { java: JAVA_AUTO });
            await this.requestLaunch(instanceId, quickPlay);
          },
          errorTitle: ACTION_ERROR.launch(instanceId),
        };
      }
      case "auto_default_java": {
        const quickPlay = s.quickPlay;
        return {
          run: async () => {
            await this.actions.updateSettings({ defaultJava: JAVA_AUTO });
            await this.requestLaunch(instanceId, quickPlay);
          },
          errorTitle: ACTION_ERROR.launch(instanceId),
        };
      }
      case "relogin": {
        const accountUuid = s.accountUuid;
        const quickPlay = s.quickPlay;
        return { run: () => this.actions.relogin(accountUuid, { kind: "launch", instanceId, quickPlay }), errorTitle: ACTION_ERROR.relogin };
      }
      case "launch_offline_once": {
        const accountUuid = s.accountUuid;
        return {
          // 用失败的那一局的账户，不看此刻的当前账户：降级判据是这个账户上一次的失败
          run: async () => {
            // 失败通知会一直留着，点下去时可能已经有一局在跑：启动会先把会话换成新的，那一局就从界面上丢了。
            // 替换确认接不上这条路（它按普通启动继续），所以另一个实例占着时让玩家自己先结束
            const active = this.raw.session;
            if (active !== null && isSessionActive(active)) {
              if (active.instanceId === instanceId) return;
              throw new Error(`「${active.instanceId}」的游戏正在运行，先结束游戏`);
            }
            const inst = this.instance(instanceId);
            if (inst.status === "installing") throw new Error(`「${instanceId}」还在安装，入口不应提供启动`);
            if (inst.status === "broken") throw new Error(`「${instanceId}」文件不完整，入口不应提供以离线方式进单人`);
            const account = this.raw.accounts.find((a) => a.uuid === accountUuid);
            if (account === undefined) throw new Error(`账户 ${accountUuid} 不存在`);
            // 以离线方式进单人只能玩单人：失败的那一局是直达存档时照旧直达那个存档，直达服务器的目标丢掉，进标题画面
            const quickPlay = s.quickPlay !== null && s.quickPlay.kind === "singleplayer" ? s.quickPlay : null;
            await this.startLaunch(instanceId, account, quickPlay, true);
          },
          errorTitle: ACTION_ERROR.launch(instanceId),
        };
      }
      case "open_game_dir":
        return { run: () => this.actions.openFolder("game_dir"), errorTitle: ACTION_ERROR.openFolder };
      case "open_logs":
        return { to: { page: "instance", id: instanceId, tab: "logs" } };
      case "pick_java":
        return { to: { page: "instance", id: instanceId, tab: "settings" } };
      case "open_client_id_settings":
        // client_id 在常规分区的高级卡片里
        return { to: { page: "settings", section: "general" } };
    }
  }

  // ---------------------------------------------------------------- 动作

  private createActions(): LauncherActions {
    const store = this;
    const actions: LauncherActions = {
      toast(tone, title, body, opts) {
        return store.pushToast(tone, title, body, opts?.action);
      },
      dismissToast(id) {
        store.set({ toasts: dismissToast(store.raw.toasts, id) });
      },
      pauseToasts(reason) {
        store.set({ toasts: pauseToasts(store.raw.toasts, reason, Date.now()) });
      },
      resumeToasts(reason) {
        store.set({ toasts: resumeToasts(store.raw.toasts, reason, Date.now()) });
      },

      // ---- 账户与登录
      async selectAccount(uuid) {
        await accountsIpc.setCurrentAccount(uuid);
        await store.fetchAccounts();
      },
      async removeAccount(uuid) {
        const account = store.raw.accounts.find((a) => a.uuid === uuid);
        if (account === undefined) throw new Error(`账户 ${uuid} 不存在`);
        await accountsIpc.removeAccount(uuid);
        await store.fetchAccounts();
        store.pushToast("info", TOAST_COPY.accountDeleted(account.name));
      },
      async refreshAccount(uuid) {
        const outcome = await accountsIpc.refreshAccount(uuid).then(
          () => "refreshed" as const,
          (error: unknown) => {
            if (isIpcError(error) && error.code === RELOGIN_REQUIRED_CODE) return "expired" as const;
            if (isIpcError(error) && error.code === APP_NOT_APPROVED_CODE) return "not_approved" as const;
            throw error;
          },
        );
        await store.fetchAccounts();
        if (outcome === "refreshed") invalidateResources(`skin:${uuid}`);
        // 通用错误通知只有后端原文，玩家看不到换 client_id 的入口
        if (outcome === "not_approved") store.pushToast("error", APP_NOT_APPROVED.title, APP_NOT_APPROVED.body, { label: APP_NOT_APPROVED.fixLabel, to: { page: "settings", section: "general" } });
        return outcome;
      },
      async addOfflineAccount(name) {
        const check = validateOfflineName(name, store.raw.accounts.map((a) => a.name));
        if (check.level === "error") throw new Error(check.message);
        const account = accountFromDto(await accountsIpc.createOfflineAccount(name));
        await store.fetchAccounts();
        await store.afterAccountAdded("offline", store.loginIntent("offline"), { title: TOAST_COPY.offlineAdded(account.name) });
        return account;
      },
      async openLogin(kind, intent = MANUAL_LOGIN) {
        if (kind === "microsoft") return actions.startMicrosoftLogin(intent);
        // 从设备码弹窗换到别的登录方式（「改用离线账户」）：先停掉后端还在轮询的微软登录
        if (store.raw.login !== null && store.raw.login.kind === "microsoft") await actions.closeMicrosoftLogin();
        if (kind === "offline") store.set({ login: { kind, intent } });
        else store.set({ login: { kind, intent, prefill: null, dropped: null } });
      },
      async openAuthlibServer(serverUrl) {
        if (store.raw.login !== null && store.raw.login.kind === "microsoft") await actions.closeMicrosoftLogin();
        store.set({ login: { kind: "authlib", intent: MANUAL_LOGIN, prefill: null, dropped: serverUrl } });
      },
      async closeLogin() {
        const login = store.raw.login;
        if (login !== null && login.kind === "microsoft") return actions.closeMicrosoftLogin();
        store.set({ login: null });
      },
      async startMicrosoftLogin(intent = MANUAL_LOGIN) {
        const gen = ++store.loginGen;
        store.clearDeviceTimer();
        store.set({ login: { kind: "microsoft", intent, device: { status: "requesting", startedAt: Date.now() } } });
        store.deviceTimer = setTimeout(() => {
          store.deviceTimer = null;
          const login = store.raw.login;
          if (gen !== store.loginGen || login === null || login.kind !== "microsoft" || login.device.status !== "requesting") return;
          // 让这一次登录作废，再请后端停掉它：它随后以 cancelled 返回时按过期的一代丢弃
          store.loginGen += 1;
          store.set({
            login: {
              ...login,
              device: { status: "failed", code: DEVICE_CODE_TIMEOUT_CODE, message: `${DEVICE_CODE_FETCH_TIMEOUT_MS / 1000} 秒内没有收到代码`, detail: null },
            },
          });
          store.background(ACTION_ERROR.cancelLogin, accountsIpc.cancelMicrosoftLogin());
        }, DEVICE_CODE_FETCH_TIMEOUT_MS);
        const existing = new Set(store.raw.accounts.map((a) => a.uuid));
        await accountsIpc.microsoftLogin().then(
          async (dto) => {
            if (gen !== store.loginGen) return;
            store.clearDeviceTimer();
            const account = accountFromDto(dto);
            await store.fetchAccounts();
            invalidateResources(`skin:${account.uuid}`);
            const login = store.raw.login;
            if (gen !== store.loginGen || login === null || login.kind !== "microsoft") return;
            if (login.intent.kind === "launch") {
              await store.afterAccountAdded("microsoft", login.intent, { title: TOAST_COPY.loggedIn(account.name) });
              return;
            }
            store.set({ login: { ...login, device: { status: "success", account, updated: existing.has(account.uuid) } } });
          },
          (error: unknown) => {
            if (gen !== store.loginGen) return;
            store.clearDeviceTimer();
            store.net.reportFailure(error);
            if (isCancelled(error)) {
              store.set({ login: null });
              return;
            }
            const login = store.raw.login;
            if (login === null || login.kind !== "microsoft") throw error;
            const failed: DeviceLogin = isIpcError(error)
              ? { status: "failed", code: error.code, message: error.message, detail: error.detail }
              : { status: "failed", code: "unknown", message: describeError(error), detail: null };
            store.set({ login: { ...login, device: failed } });
          },
        );
      },
      async closeMicrosoftLogin() {
        const login = store.raw.login;
        store.loginGen += 1;
        store.clearDeviceTimer();
        store.set({ login: null });
        const pending = login !== null && login.kind === "microsoft" && (login.device.status === "requesting" || login.device.status === "waiting");
        if (pending) await accountsIpc.cancelMicrosoftLogin();
      },
      async probeAuthServer(url) {
        return authServerFromDto(await accountsIpc.probeAuthServer(url));
      },
      async authlibLogin(serverUrl, username, password) {
        const result = await accountsIpc.authlibLogin(serverUrl, username, password);
        if (result.status === "select_profile") {
          return { status: "select_profile", pendingId: result.pending_id, serverName: result.server_name, profiles: result.profiles.map(authlibProfileFromDto) };
        }
        const account = accountFromDto(result.account);
        await store.fetchAccounts();
        await store.afterAuthlib(account);
        return { status: "logged_in", account };
      },
      async selectAuthlibProfile(pendingId, profileUuid) {
        const account = accountFromDto(await accountsIpc.selectAuthlibProfile(pendingId, profileUuid));
        await store.fetchAccounts();
        await store.afterAuthlib(account);
        return account;
      },
      async relogin(accountUuid, intent) {
        const account = store.raw.accounts.find((a) => a.uuid === accountUuid);
        if (account === undefined) throw new Error(`账户 ${accountUuid} 不存在`);
        if (account.kind === "microsoft") return actions.startMicrosoftLogin(intent);
        if (account.kind === "authlib") {
          if (account.serverUrl === null || account.authServer === null) throw new Error(`外置登录账户 ${account.name} 缺少验证服务器`);
          store.set({ login: { kind: "authlib", intent, prefill: { serverUrl: account.serverUrl, serverName: account.authServer, username: account.username }, dropped: null } });
          return;
        }
        throw new Error("离线账户没有登录状态，不需要重新登录");
      },

      // ---- 实例
      async selectInstance(id) {
        // 已经是当前实例时不再写配置（新建实例入队时已设过，新建流程收尾可能再设一次）
        if (store.raw.settings !== null && store.raw.settings.selectedVersion === id) return;
        const readsIssued = store.settingsIssued;
        await configIpc.updateConfig({ selectedVersion: id });
        store.selectionWrite = { id, readsIssued };
        store.set((raw) => ({ settings: raw.settings === null ? null : { ...raw.settings, selectedVersion: id } }));
      },
      togglePin(id) {
        return store.queueSidebarPins(async () => {
          // 侧栏显示的固定项含安装中自动固定的新实例，上限按显示的算
          const shown = store.getState().sidebarPins;
          if (!shown.includes(id) && shown.length >= SIDEBAR_PIN_LIMIT) {
            store.pushToast("warning", TOAST_COPY.pinLimit);
            return;
          }
          const pending = store.pendingCreate(id);
          if (pending !== null) {
            // 还在安装的新实例后端不认，只改它装好后要不要固定
            store.set((raw) => ({ taskMeta: { ...raw.taskMeta, [pending.taskId]: { ...pending.meta, autoPin: !shown.includes(id) } } }));
            return;
          }
          const pins = store.raw.pins;
          const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
          await store.writePins(next);
        });
      },
      setSidebarPins(ids) {
        return store.queueSidebarPins(async () => {
          // 安装中自动固定的新实例总排在末尾，不写进固定列表（装好后才写）
          const persisted = ids.filter((id) => store.pendingCreate(id) === null);
          const before = store.raw.pins;
          store.set({ pins: persisted });
          // 拖动排序先乐观改顺序；写入失败恢复原顺序后把错误原样交给外层
          try {
            await store.writePins(persisted);
          } catch (error) {
            store.set({ pins: before });
            throw error;
          }
        });
      },
      async createInstance(spec) {
        const nameError = instanceNameError(spec.name, store.instanceIds());
        if (nameError !== null) throw new Error(nameError);
        if (spec.loader !== "vanilla" && spec.loaderVersion === null) throw new Error(`${spec.loader} 实例需要加载器版本`);
        const loader = spec.loader === "vanilla" ? null : spec.loader;
        const autoPin = store.getState().sidebarPins.length < SIDEBAR_PIN_LIMIT;
        const useTemplate = spec.useTemplate === true;
        const starter = spec.starterMods === undefined ? [] : spec.starterMods;
        const task = store.enqueue(
          {
            kind: "game",
            title: TASK_TEXT.createTitle(spec.mcVersion, spec.loader, spec.loaderVersion),
            detail: TASK_TEXT.createDetail(spec.name),
            instanceId: spec.name,
            spec: { command: "install_version", args: { id: spec.mcVersion, loader, loaderVersion: loader === null ? null : spec.loaderVersion, targetName: spec.name, useTemplate, ...starterArgs(starter) } },
          },
          { type: "create", name: spec.name, mcVersion: spec.mcVersion, loader: spec.loader, loaderVersion: spec.loaderVersion, cover: spec.cover, autoPin, starter },
          spec.name,
        );
        // 新实例即成为当前实例：主页「继续游玩」显示它的安装进度
        if (task !== null) await actions.selectInstance(spec.name);
        return spec.name;
      },
      async installModpack(spec) {
        const nameError = instanceNameError(spec.name, store.instanceIds());
        if (nameError !== null) throw new Error(nameError);
        store.enqueue(
          {
            kind: "modpack",
            title: TASK_TEXT.modpackTitle(spec.packName),
            detail: TASK_TEXT.modpackDetail(spec.packVersion, spec.modCount),
            instanceId: spec.name,
            spec: { command: "install_modpack", args: { source: spec.source, name: spec.name, excludedOptional: [...spec.excludedOptional] } },
          },
          {
            type: "modpack",
            name: spec.name,
            cover: spec.cover,
            modCount: spec.modCount,
            mcVersion: spec.mcVersion,
            loader: spec.loader,
            loaderVersion: spec.loaderVersion,
          },
          spec.packName,
        );
        return spec.name;
      },
      async exportModpack(id, options) {
        const inst = store.instance(id);
        const spec = { command: "export_modpack", args: { id, options } };
        const task = store.enqueue(
          { kind: "modpack_export", title: TASK_TEXT.exportTitle(options.name), detail: TASK_TEXT.exportDetail(options.version, inst.name), instanceId: id, spec },
          { type: "export", name: options.name },
          options.name,
        );
        if (task === null) {
          // 同一份导出（同实例、同参数、同位置）已在队列里：入队已经提示过，交回那个任务
          const existing = findDuplicate(store.raw.tasks, spec);
          if (existing === undefined) throw new Error(`导出「${options.name}」没有入队，队列里也没有同样的任务`);
          return existing.id;
        }
        const copy = TASK_TOAST.exportStarted(options.name);
        store.pushToast("info", copy.title, copy.body);
        return task.id;
      },
      async previewInstanceDeletion(id) {
        return instancesIpc.previewInstanceDeletion(id);
      },
      async deleteInstance(id, worldCount) {
        if (store.sessionActiveFor(id)) throw new Error(`「${id}」的游戏正在运行，先结束游戏`);
        // 取消排队中的新建任务后占位项随之消失，先记下它是不是占位
        const placeholder = store.instance(id).placeholder;
        const doomed = store.raw.tasks.filter((t) => isActiveTask(t) && t.instanceId === id).map((t) => t.id);
        for (const taskId of doomed) store.discardLanding.add(taskId);
        let lagged: IpcError | null = null;
        try {
          await store.cancelInstanceTasks(id);
          // 占位实例的取消没赶上时（安装在宽限期内做完，或取消到达前就失败、留下了未完成的目录），实例已经在盘上，
          // 照样要删；赶上了的，后端已经删掉半成品。重扫一次按盘上的实际情况定
          if (placeholder) await store.fetchInstances();
          if (!placeholder || store.raw.scanned.some((i) => i.id === id)) {
            lagged = await instancesIpc.deleteInstance(id).then(
              () => null,
              (err: unknown) => playRecordsLag(err),
            );
          }
        } finally {
          for (const taskId of doomed) store.discardLanding.delete(taskId);
        }
        const s = store.raw.session;
        if (s !== null && s.instanceId === id) store.set({ session: null });
        store.set((raw) => ({ toasts: detachToasts(raw.toasts, id) }));
        await Promise.all([store.fetchInstances(), store.fetchPins(), store.fetchSettings()]);
        for (const prefix of INSTANCE_SCOPED_RESOURCES) invalidateResources(`${prefix}:${id}`);
        // 后端随删除清掉了它的游玩记录，日历与洞察不能还算着它；记住它的固定服务器也一并忘掉了
        invalidateResources("play-stats");
        invalidateResources("servers");
        const copy = TOAST_COPY.instanceDeleted(id, worldCount);
        store.pushToast("info", copy.title, copy.body);
        if (lagged !== null) store.playRecordsLagged(id, lagged);
      },
      async renameInstance(id, name) {
        const nameError = instanceNameError(name, store.instanceIds(), id);
        if (nameError !== null) throw new Error(nameError);
        const { newId, lagged } = await instancesIpc.renameInstance(id, name).then(
          (outcome): { newId: string; lagged: IpcError | null } => ({ newId: outcome.id, lagged: null }),
          (err: unknown) => {
            const lag = renameLag(err);
            return { newId: renamedTo(lag), lagged: lag };
          },
        );
        store.instanceIdTaken(newId);
        // 游玩记录已迁到新名字下（没跟上的由后端在下一次读时补上）：主页日历按旧 id 找不到实例，会把改了名的说成已删除。
        // 记住它的固定服务器也跟到了新名字下
        invalidateResources("play-stats");
        invalidateResources("servers");
        store.migrateRenamed(id, newId);
        store.scheduleJournal();
        if (lagged !== null && lagged.code === instancesIpc.WORLD_BACKUPS_NOT_MOVED_ERROR_CODE) store.backupsLagged(newId, lagged);
        else if (lagged !== null) store.playRecordsLagged(newId, lagged);
        // 改名已经落盘，之后读不出来不是改名失败：照成功返回，读取的失败按刷新失败另发通知，不说成没改成
        await Promise.all([store.fetchPins(), store.fetchSettings(), store.fetchInstances()]).catch((error: unknown) =>
          store.report(ACTION_ERROR.refreshInstances, error),
        );
        return newId;
      },
      async updateInstanceSettings(id, patch) {
        const saved = await store.queueInstanceSettings(id, async () => {
          const current = instanceSettingsFromDto(await instancesIpc.getInstanceSettings(id));
          return instanceSettingsFromDto(await instancesIpc.setInstanceSettings(id, instanceSettingsToDto({ ...current, ...patch })));
        });
        invalidateResources(`settings:${id}`);
        if (LISTED_INSTANCE_SETTINGS.some((key) => key in patch)) await store.fetchInstances();
        return saved;
      },
      async repairInstance(id, opts = {}) {
        if (store.sessionActiveFor(id)) throw new Error(`「${id}」的游戏正在运行，先结束游戏`);
        store.enqueueRepair(id, opts.launchAfter === true, [], opts.reinstallLoader === true);
      },
      async saveInstanceAsTemplate(id) {
        await instancesIpc.saveInstanceAsTemplate(id);
        invalidateResources("template");
        const copy = TOAST_COPY.templateSaved(id);
        store.pushToast("success", copy.title, copy.body);
      },
      async clearTemplate() {
        await instancesIpc.clearTemplate();
        invalidateResources("template");
        store.pushToast("info", TOAST_COPY.templateCleared);
      },
      async openFolder(target, id = null, world = null) {
        await instancesIpc.openFolder(target, id, world);
      },
      async revealPath(path) {
        await instancesIpc.revealInFolder(path);
      },
      async openExternal(url) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`只能打开 http(s) 网址：${url}`);
        // 交给 opener 插件的命令而不是 target="_blank" 的链接：注入脚本接管链接点击时不等结果，打开失败就悄悄没了
        await invoke<void>(OPEN_URL_COMMAND, { url: parsed.href });
      },
      async downloadsFolder() {
        return downloadsFolder();
      },
      async claimBlockedFiles(folder, files) {
        return claimBlockedFiles(folder, files).then(
          (report): ClaimOutcome => {
            // 认领到的可能是整合包本体：之前因为它读不出来的摘要现在读得到了
            if (report.claimed.length > 0) invalidateResources(MODPACK_SUMMARY_RESOURCE);
            return { kind: "report", report };
          },
          (error: unknown): ClaimOutcome => {
            if (isIpcError(error) && error.code === IO_ERROR_CODE) return { kind: "folder_error", message: error.message };
            throw error;
          },
        );
      },
      async refreshInstances() {
        await store.fetchInstances();
      },

      // ---- 启动会话
      async launch(id) {
        await store.requestLaunch(id, null);
      },
      async quickPlay(id, target) {
        await store.requestLaunch(id, target);
      },
      async stop() {
        const s = store.raw.session;
        if (s === null || !isSessionActive(s)) return;
        // 10 s 时限从发出请求起算，覆盖 IPC 本身与之后等待结局的整段
        const ended = store.waitSessionEnd(s.taskId);
        const request = (async () => {
          if (!isLoadingPhase(s.phase)) return launchIpc.stopGame();
          const wasRunning = await tasksIpc.cancelTask(s.taskId);
          // 取消到达时启动刚好完成：此时游戏已在运行，改为结束游戏
          const cur = store.raw.session;
          if (!wasRunning && cur !== null && cur.taskId === s.taskId && cur.phase === "running") await launchIpc.stopGame();
        })();
        await Promise.all([request, ended]);
      },
      dismissSession() {
        const s = store.raw.session;
        if (s === null || isSessionActive(s)) return;
        store.set({ session: null });
      },
      async resolveLaunchPrompt(accept) {
        const prompt = store.raw.launchPrompt;
        if (prompt === null) return;
        store.set({ launchPrompt: null });
        if (!accept) return;
        await actions.stop();
        // 替换时不等已结束会话的 1500 ms 停留，直接开始新的
        store.set({ session: null });
        await store.requestLaunch(prompt.instanceId, prompt.quickPlay);
      },
      failureFix(kind) {
        const s = store.raw.session;
        if (s === null || s.phase !== "failed") throw new Error("当前没有启动失败的会话");
        return store.fixTarget(s, kind);
      },

      // ---- Mod 与资源
      async toggleMod(instanceId, fileName, enabled) {
        store.assertModsEditable(instanceId);
        await modsIpc.setModEnabled(instanceId, fileName, enabled);
        invalidateResources(`mods:${instanceId}`);
      },
      async updateMod(instanceId, fileName) {
        store.assertModsEditable(instanceId);
        const candidate = (await modsIpc.checkUpdates(instanceId)).find((c) => c.file_name === fileName);
        if (candidate === undefined) throw new Error(`${fileName} 没有可用的更新`);
        store.enqueueUpdate(instanceId, candidate);
      },
      async toggleMods(instanceId, fileNames, enabled) {
        store.assertModsEditable(instanceId);
        const results = await modsIpc.setModsEnabled(instanceId, fileNames, enabled);
        invalidateResources(`mods:${instanceId}`);
        const failed = results.flatMap((r) => (r.status === "error" ? [r.error.message] : []));
        if (failed.length > 0) {
          store.pushToast("warning", TOAST_COPY.modsToggleFailed(failed.length, enabled), batchFailureReason(failed));
          return;
        }
        if (enabled) store.pushToast("info", TOAST_COPY.modsEnabled(results.length));
        else {
          const copy = TOAST_COPY.modsDisabled(results.length);
          store.pushToast("info", copy.title, copy.body);
        }
      },
      async addLocalMods(instanceId, paths) {
        if (paths.length === 0) throw new Error("添加本地 Mod 至少要有一个文件");
        store.assertModsEditable(instanceId);
        let results: modsIpc.LocalModResult[];
        try {
          results = await modsIpc.addLocalMods(instanceId, paths);
        } finally {
          // 落盘之后写历史失败也是整次报错，文件已经在 mods 里：列表、历史与可更新项不能停在动手之前
          store.modsChanged(instanceId);
        }
        await store.fetchInstances();
        const added = results.flatMap((r) => (r.status === "ok" ? [r.file_name] : []));
        const failed = results.flatMap((r) => (r.status === "error" ? [r.error.message] : []));
        if (failed.length > 0) store.pushToast("warning", TOAST_COPY.modsAddFailed(added.length, failed.length), batchFailureReason(failed));
        else store.pushToast("success", added.length === 1 ? TOAST_COPY.modAdded(added[0]) : TOAST_COPY.modsAdded(added.length));
      },
      async updateAllMods(instanceId, picked) {
        store.assertModsEditable(instanceId);
        let found: readonly modsIpc.UpdateCandidate[];
        if (picked === undefined) {
          found = await modsIpc.checkUpdates(instanceId);
          if (found.length === 0) {
            store.pushToast("info", TOAST_COPY.allModsLatest);
            return;
          }
        } else {
          if (picked.length === 0) throw new Error("更新预览至少要勾选一个 Mod");
          found = picked;
        }
        // 已有更新任务在换的文件这次不排：检查更新照样会报它们，更新预览开着时勾的也可能已经排上了；
        // 两个任务同时换同一个文件和卷宗，后跑的那个按旧文件名再换一遍
        const busy = modFilesBeingUpdated(store.raw.tasks, instanceId);
        const candidates = found.filter((c) => !busy.has(c.file_name));
        if (candidates.length === 0) {
          const only = found.length === 1 ? found[0] : null;
          const subject = only === null ? TASK_TEXT.updateAllTitle(found.length) : only.title === null ? only.file_name : only.title;
          store.pushToast("info", TASK_TOAST.duplicate(subject).title);
          return;
        }
        // 只有一个可更新时就是单个 Mod 的更新，标题与通知写 Mod 名；多个合成一个任务、一条通知
        if (candidates.length === 1) {
          store.enqueueUpdate(instanceId, candidates[0]);
          return;
        }
        store.enqueue(
          {
            kind: "mod",
            title: TASK_TEXT.updateAllTitle(candidates.length),
            detail: TASK_TEXT.updateAllDetail(instanceId),
            instanceId,
            spec: {
              command: "update_mods",
              args: {
                versionId: instanceId,
                items: candidates.map((c) => ({
                  fileName: c.file_name,
                  platform: c.latest.platform,
                  projectId: c.latest.project_id,
                  modVersionId: c.latest.version_id,
                  title: c.title === null ? c.file_name : c.title,
                  fileSize: c.latest.file_size,
                })),
              },
            },
          },
          { type: "updates", instanceId },
          TASK_TEXT.updateAllTitle(candidates.length),
        );
      },
      async removeMod(instanceId, fileName, name) {
        store.assertModsEditable(instanceId);
        await modsIpc.removeMod(instanceId, fileName);
        store.modsChanged(instanceId);
        await store.fetchInstances();
        store.pushToast("info", TOAST_COPY.modRemoved(name));
      },
      async removeMods(instanceId, files) {
        if (files.length === 0) throw new Error("批量移除至少要有一个 Mod");
        store.assertModsEditable(instanceId);
        const failed: string[] = [];
        try {
          for (const file of files) {
            try {
              await modsIpc.removeMod(instanceId, file.fileName);
            } catch (err) {
              if (!isIpcError(err)) throw err;
              failed.push(err.message);
            }
          }
        } finally {
          // 中途出了意外也已经删掉了前面几个：列表、历史与可更新项不能停在动手之前
          store.modsChanged(instanceId);
        }
        await store.fetchInstances();
        if (failed.length > 0) store.pushToast("warning", TOAST_COPY.modsRemoveFailed(failed.length), batchFailureReason(failed));
        else store.pushToast("info", TOAST_COPY.modsRemoved(files.length));
      },
      async setModUpdateHold(instanceId, fileName, name, hold) {
        // 只写卷宗、不碰 jar，所以运行中照常可用；补全在写整个目录，界面已禁用入口，这里是第二道防线
        if (store.instance(instanceId).status === "installing") throw new Error(`「${instanceId}」正在补全文件`);
        await modsIpc.setModUpdateHold(instanceId, fileName, hold);
        invalidateResources(`mods:${instanceId}`);
        invalidateResources(`mod-updates:${instanceId}`);
        if (hold === null) store.pushToast("info", TOAST_COPY.updateRestored(name));
        else {
          const copy = TOAST_COPY.updateIgnored(name);
          store.pushToast("info", copy.title, copy.body);
        }
      },
      async installResource(spec) {
        const enqueued: string[] = [];
        // 某个实例的安装计划失败不挡其余实例：先把排得上的排上并照常通知，最后再报出没排上的。半路中断的话，
        // 前面已排上的没有通知，后面的不再排，再点安装时前面的又报「已在下载队列里」
        const failures: { instanceId: string; error: unknown }[] = [];
        for (const target of spec.targets) {
          if (spec.resourceType === "mod") {
            const plan = await modsIpc.planInstall(target.instanceId, spec.platform, spec.projectId, target.fileVersionId).catch((error: unknown) => {
              failures.push({ instanceId: target.instanceId, error });
              return null;
            });
            if (plan === null) continue;
            const items = plan.items.filter((item) => !item.already_satisfied);
            if (items.length === 0) {
              store.pushToast("info", TASK_TOAST.alreadyInstalled(spec.name, target.instanceId).title);
              continue;
            }
            const task = store.enqueue(
              {
                kind: "mod",
                title: TASK_TEXT.installTitle(spec.name),
                detail: TASK_TEXT.installDetail(target.instanceId, items.length - 1),
                instanceId: target.instanceId,
                spec: {
                  command: "install_mods",
                  args: {
                    versionId: target.instanceId,
                    platform: spec.platform,
                    projectId: spec.projectId,
                    items: items.map((item, i) => ({
                      platform: item.version.platform,
                      projectId: item.version.project_id,
                      modVersionId: item.version.version_id,
                      title: i === 0 ? spec.name : item.title === null ? item.version.name : item.title,
                      fileSize: item.version.file_size,
                    })),
                  },
                },
              },
              { type: "mods", instanceId: target.instanceId, name: spec.name, dependencies: items.length - 1 },
              spec.name,
            );
            if (task !== null) enqueued.push(target.instanceId);
            continue;
          }
          const task = store.enqueue(
            {
              kind: RESOURCE_KIND[spec.resourceType],
              title: TASK_TEXT.installTitle(spec.name),
              detail: TASK_TEXT.installDetail(target.instanceId, 0),
              instanceId: target.instanceId,
              spec: {
                command: "install_resource",
                args: {
                  versionId: target.instanceId,
                  resourceType: spec.resourceType,
                  world: target.world,
                  platform: spec.platform,
                  projectId: spec.projectId,
                  fileVersionId: target.fileVersionId,
                },
              },
            },
            { type: "resource", instanceId: target.instanceId, resourceType: spec.resourceType, name: spec.name },
            spec.name,
          );
          if (task !== null) enqueued.push(target.instanceId);
        }
        if (enqueued.length > 0) {
          const copy = TASK_TOAST.enqueued(spec.name, enqueued);
          store.pushToast("info", copy.title, copy.body);
        }
        // 只有一个没排上时原样抛出它的错误，错误码与联网判定照旧；几个时合成一句，逐个写明实例与原因
        if (failures.length === 1) throw failures[0].error;
        if (failures.length > 1) {
          throw new Error(`${failures.length} 个实例没能加入下载队列：${failures.map((f) => `「${f.instanceId}」${describeError(f.error)}`).join("；")}`);
        }
      },
      async rollback(instanceId, eventId) {
        store.assertModsEditable(instanceId);
        const check = (await rollbackChecks(instanceId)).find((c) => c.event_id === eventId);
        if (check === undefined) throw new Error(`变更历史里没有事件 ${eventId}`);
        if (!check.can_rollback) {
          store.pushToast("warning", TOAST_COPY.cannotRollback, check.reason === null ? undefined : check.reason);
          return;
        }
        const event = (await listHistory(instanceId)).find((e) => e.id === eventId);
        await rollbackIpc(instanceId, eventId);
        store.modsChanged(instanceId);
        if (event !== undefined && event.kind === "update") {
          const name = event.title === null ? event.file_name : event.title;
          const from = event.from_version_number === null ? event.from_version : event.from_version_number;
          const to = event.to_version_number === null ? event.to_version : event.to_version_number;
          const copy = TOAST_COPY.rolledBack(name, from, to);
          store.pushToast("success", copy.title, copy.body);
        }
      },
      async installJava(major, opts = {}) {
        store.enqueue(
          {
            kind: "java",
            title: TASK_TEXT.javaTitle(major),
            detail: TASK_TEXT.javaDetailPending,
            instanceId: null,
            spec: { command: "install_java", args: { requiredMajor: major } },
          },
          {
            type: "java",
            major,
            launchAfter: opts.launchAfter === undefined ? null : opts.launchAfter,
            pinFor: opts.pinFor === undefined ? null : opts.pinFor,
          },
          `Java ${major}`,
        );
      },

      // ---- 存档备份
      async backupWorld(instanceId, world, name) {
        if (store.sessionActiveFor(instanceId)) throw new Error(`「${instanceId}」的游戏正在运行，退出后再备份`);
        const task = store.enqueueWorld(instanceId, world, name, "backup", { command: "backup_world", args: { id: instanceId, world } });
        if (task === null) return;
        const copy = TASK_TOAST.backupStarted(name);
        store.pushToast("info", copy.title, copy.body);
      },
      async restoreWorldBackup(instanceId, world, name, file) {
        if (store.sessionActiveFor(instanceId)) throw new Error(`「${instanceId}」的游戏正在运行，退出后再恢复`);
        store.enqueueWorld(instanceId, world, name, "restore", { command: "restore_world_backup", args: { id: instanceId, world, file } });
      },
      async exportWorld(instanceId, world, name, dest) {
        if (store.sessionActiveFor(instanceId)) throw new Error(`「${instanceId}」的游戏正在运行，退出后再导出`);
        store.enqueueWorld(instanceId, world, name, "export", { command: "export_world", args: { id: instanceId, world, dest } });
      },
      async deleteWorldBackup(instanceId, world, file) {
        await instancesIpc.deleteWorldBackup(instanceId, world, file);
        invalidateResources(WORLD_BACKUPS_RESOURCE);
        store.pushToast("info", TOAST_COPY.backupDeleted.title, TOAST_COPY.backupDeleted.body);
      },
      async listWorldBackups(instanceId, world) {
        return instancesIpc.listWorldBackups(instanceId, world);
      },

      // ---- 下载任务
      async cancelTask(id) {
        const task = store.findTask(id);
        if (task.status === "queued") {
          store.set((raw) => ({ tasks: trimHistory(markCancelled(raw.tasks, id, Date.now())) }));
          store.pushToast("info", TASK_TOAST.cancelled(task.title).title);
          store.tasksChanged();
          return;
        }
        if (task.status !== "running") throw new Error(`任务 ${id} 已经结束`);
        // 运行中的任务由命令以 cancelled 返回后落态与通知
        await store.requestCancel(task);
      },
      async cancelAllTasks() {
        const active = store.raw.tasks.filter(isActiveTask);
        await Promise.all(active.map((t) => actions.cancelTask(t.id)));
      },
      retryTask(id) {
        const task = store.findTask(id);
        const leftover = store.leftoverOfFailedCreate(task);
        if (leftover !== null) {
          store.retryAsRepair(task, leftover);
          return;
        }
        const duplicate = findDuplicate(store.raw.tasks, task.spec);
        if (duplicate !== undefined) {
          store.pushToast("info", TASK_TOAST.duplicate(task.title).title);
          return;
        }
        store.set((raw) => ({ tasks: retryTask(raw.tasks, id), ...store.restoredMeta(raw, task) }));
        store.tasksChanged();
      },
      retryFailedTasks() {
        let retried = 0;
        try {
          for (const task of store.raw.tasks.filter((t) => t.status === "failed" && !awaitsManualFiles(t))) {
            const leftover = store.leftoverOfFailedCreate(task);
            if (leftover !== null) {
              // 与下面一样，已在队列里的同一件事静默跳过，不逐条提示重复
              if (findDuplicate(store.raw.tasks, { command: "repair_instance", args: { id: leftover } }) === undefined && store.retryAsRepair(task, leftover)) retried += 1;
              continue;
            }
            // 逐个排：前一个重试后，同一件事的后一个就算重复
            if (findDuplicate(store.raw.tasks, task.spec) !== undefined) continue;
            store.set((raw) => ({ tasks: retryTask(raw.tasks, task.id), ...store.restoredMeta(raw, task) }));
            retried += 1;
          }
        } finally {
          // 任务日志里的坏记录读参数时会抛错：已经排回队列的照样要调度，否则停在排队，再也没有事件拉起它们
          if (retried > 0) store.tasksChanged();
        }
        return retried;
      },
      clearFinishedTasks() {
        store.set((raw) => ({ tasks: clearFinished(raw.tasks), unseenFailures: [] }));
        store.scheduleJournal();
      },
      markFailuresSeen() {
        if (store.raw.unseenFailures.length === 0) return;
        store.set({ unseenFailures: [] });
      },
      async flushTaskJournal() {
        if (store.journalTimer !== null) clearTimeout(store.journalTimer);
        store.journalTimer = null;
        await store.saveJournal();
      },

      // ---- 设置
      async updateSettings(patch) {
        await configIpc.updateConfig(settingsPatchToConfig(patch));
        await store.fetchSettings();
      },
      async addJavaPath(path) {
        const java = await javaIpc.addJavaPath(path);
        invalidateResources("java");
        await store.fetchSettings();
        return java;
      },
      async removeJavaPath(path) {
        const result = await javaIpc.removeJavaPath(path);
        invalidateResources("java");
        await store.fetchSettings();
        return result;
      },
      async setGameDirectory(path) {
        await configIpc.setGameDirectory(path);
        store.set((raw) => ({ toasts: detachInstanceToasts(raw.toasts) }));
        for (const prefix of GAME_DIR_SCOPED_RESOURCES) invalidateResources(prefix);
        await Promise.all([store.fetchSettings(), store.fetchInstances(), store.fetchPins()]);
      },
      async commitFirstRun(gameDir, extraDirectories) {
        await completeFirstRun(gameDir, extraDirectories);
        store.firstRunCommitted = true;
        await Promise.all([store.fetchSettings(), store.fetchInstances(), store.fetchPins()]);
      },
      finishFirstRun() {
        if (!store.firstRunCommitted) throw new Error("首次启动向导的第一步还没有提交，不能收尾");
        store.set({ firstRun: false });
      },
      async completeFirstRun(gameDir, extraDirectories) {
        await completeFirstRun(gameDir, extraDirectories);
        store.firstRunCommitted = true;
        store.set({ firstRun: false });
        await Promise.all([store.fetchSettings(), store.fetchInstances(), store.fetchPins()]);
      },
      async togglePinServer(server) {
        await store.queueServerPins(async () => {
          const current = await listPinnedServers();
          const pinned = current.some((s) => s.address === server.address);
          // 新固定的服务器还没选过加入用的实例
          await setPinnedServers(pinned ? current.filter((s) => s.address !== server.address) : [...current, { name: server.name, address: server.address, instance: null }]);
        });
      },
      async setPinnedServerInstance(address, instance) {
        await store.queueServerPins(() => setPinnedServerInstance(address, instance));
      },
      async reload(slice) {
        await store.loadSlice(slice);
      },
    };
    return actions;
  }

  /**
   * 固定服务器的读改写排成一条链串行执行，写成功后让服务器查询失效。链只负责排队：这一次的失败经返回的 Promise
   * 照常抛给调用方，不挡后面排着的写入。
   */
  private async queueServerPins(write: () => Promise<unknown>): Promise<void> {
    const run = this.serverPinChain.then(async () => {
      await write();
      invalidateResources("servers");
    });
    this.serverPinChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async afterAuthlib(account: Account): Promise<void> {
    if (account.authServer === null) throw new Error(`外置登录账户 ${account.name} 缺少服务器名`);
    invalidateResources(`skin:${account.uuid}`);
    const copy = TOAST_COPY.authlibAdded(account.name, account.authServer);
    await this.afterAccountAdded("authlib", this.loginIntent("authlib"), copy);
  }

  /**
   * 排一个补全任务；同一件事已在队列里时提示重复并返回 null。starter 为补全好之后接着装的开局 Mod。reinstallLoader 记在命令
   * 参数里，任务重试、重启后恢复都原样带着；不重装时不写这个键，后端按缺省的补全处理。
   */
  private enqueueRepair(id: string, launchAfter: boolean, starter: StarterPick[], reinstallLoader: boolean): Task | null {
    const inst = this.instance(id);
    const spec = inst.incomplete === null ? null : inst.incomplete.spec;
    const mcVersion = inst.mcVersion !== null ? inst.mcVersion : spec === null ? null : spec.mcVersion;
    const detail =
      mcVersion === null
        ? TASK_TEXT.repairDetailUnknown
        : inst.mcVersion !== null
          ? TASK_TEXT.repairDetail(mcVersion, inst.loader, inst.loaderVersion)
          : TASK_TEXT.repairDetail(mcVersion, loaderOfArg(spec === null ? null : spec.loader), spec === null ? null : spec.loaderVersion);
    return this.enqueue(
      {
        kind: "repair",
        title: reinstallLoader ? TASK_TEXT.reinstallLoaderTitle(id) : TASK_TEXT.repairTitle(id),
        detail,
        instanceId: id,
        spec: { command: "repair_instance", args: { id, ...starterArgs(starter), ...(reinstallLoader ? { reinstallLoader } : {}) } },
      },
      { type: "repair", launchAfter, starter },
      id,
    );
  }

  /**
   * 失败的新建在盘上留下了带安装标记的目录时，它的实例 id；否则 null。这时照原样重跑 install_version 必然
   * 以名称重复失败（后端把这个目录算作已有实例），重试要改成按标记里记下的内容补全。
   */
  private leftoverOfFailedCreate(task: Task): string | null {
    if (task.spec.command !== "install_version") return null;
    const name = strArg(task.spec.args, "targetName", task.spec.command).toLowerCase();
    const leftover = this.raw.scanned.find((i) => i.id.toLowerCase() === name && i.incomplete !== null && i.incomplete.kind === "install");
    return leftover === undefined ? null : leftover.id;
  }

  /**
   * 失败新建的重试改排补全：补全任务接替这一行，失败的那一行撤下，不再留着一个点了也没用的重试。新建时勾的开局 Mod
   * 跟着交给补全任务，否则重试成功后玩家勾的 Mod 一个都没装上，也没有任何提示。
   */
  private retryAsRepair(task: Task, instanceId: string): boolean {
    const meta = this.metaOf(task);
    const starter = meta !== null && meta.type === "create" ? meta.starter : [];
    if (this.enqueueRepair(instanceId, false, starter, false) === null) return false;
    this.set((raw) => ({ tasks: raw.tasks.filter((t) => t.id !== task.id) }));
    this.tasksChanged();
    return true;
  }

  /** 排一个备份、导出或恢复任务；导出与备份同是打包，都记作 world_backup。同一件事已在队列里时提示重复并返回 null。 */
  private enqueueWorld(instanceId: string, world: string, name: string, op: "backup" | "restore" | "export", spec: Task["spec"]): Task | null {
    const title = op === "backup" ? TASK_TEXT.backupTitle(name) : op === "export" ? TASK_TEXT.exportWorldTitle(name) : TASK_TEXT.restoreTitle(name);
    return this.enqueue(
      { kind: op === "restore" ? "world_restore" : "world_backup", title, detail: TASK_TEXT.backupDetail(instanceId), instanceId, spec },
      { type: "world", instanceId, world, name, op },
      title,
    );
  }

  private enqueueUpdate(instanceId: string, candidate: modsIpc.UpdateCandidate): void {
    const name = candidate.title === null ? candidate.file_name : candidate.title;
    const from = candidate.current_version_number === null ? candidate.current_version_id : candidate.current_version_number;
    this.enqueue(
      {
        kind: "mod",
        title: TASK_TEXT.updateTitle(name),
        detail: TASK_TEXT.updateDetail(from, candidate.latest.version_number, instanceId),
        instanceId,
        spec: { command: "update_mod", args: { versionId: instanceId, fileName: candidate.file_name, modVersionId: candidate.latest.version_id } },
      },
      { type: "update", instanceId, name },
      name,
    );
  }
}

/** 确认对话框里「替换运行中的游戏」两种文案，供外壳弹确认时用。 */
export function launchPromptCopy(prompt: LaunchPrompt): { title: string; body: string; confirmLabel: string; tone: "primary" | "danger" } {
  if (prompt.occupantPhase === "loading") return { ...CONFIRM_COPY.replaceLoading(prompt.instanceId, prompt.occupantId), tone: "primary" };
  return { ...CONFIRM_COPY.replaceRunning(prompt.instanceId, prompt.occupantId), tone: "danger" };
}
