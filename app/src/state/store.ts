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
  BOOT_SLICE_ERROR,
  CONFIRM_COPY,
  DEVICE_CODE_TIMEOUT_CODE,
  isCrashCategory,
  NEXT_LAUNCH_SUFFIX,
  TASK_TEXT,
  TASK_TOAST,
  TOAST_COPY,
  failureCopy,
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
import type { FailureCode, LoaderKind, Platform, Task, TaskKind } from "../domain/types";
import * as accountsIpc from "../ipc/accounts";
import { invoke, type UnlistenFn } from "../ipc/bridge";
import * as configIpc from "../ipc/config";
import { lastCrash } from "../ipc/diagnostics";
import { installMod, type InstallableResourceType, type ResourceInstallOutcomeDto } from "../ipc/discover";
import { CANCELLED_ERROR_CODE, IpcError, isCancelled, isIpcError } from "../ipc/errors";
import { listHistory, rollback as rollbackIpc, rollbackChecks } from "../ipc/history";
import * as instancesIpc from "../ipc/instances";
import type { DeletionPreviewDto, FolderTarget, InstallResultDto, InstanceDto } from "../ipc/instances";
import type { InstalledRuntimeDto } from "../ipc/java";
import * as launchIpc from "../ipc/launch";
import type { ModpackInstallOutcomeDto, ModpackSource } from "../ipc/modpack";
import * as modsIpc from "../ipc/mods";
import { completeFirstRun, isFirstRun, listPinnedServers, setPinnedServers, type PinnedServerDto } from "../ipc/system";
import * as tasksIpc from "../ipc/tasks";
import type { CoreEvent } from "../ipc/tasks";
import { describeError, errorRecord } from "./errors";
import { MANUAL_LOGIN, type DeviceLogin, type LoginIntent, type LoginKind, type LoginState } from "./login";
import { network as appNetwork, type NetworkMonitor } from "./online";
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
  applyTaskDownload,
  attemptTaskId,
  clearFinished,
  findDuplicate,
  isActiveTask,
  markCancelled,
  markDone,
  markFailed,
  markRunning,
  newTask,
  restoreJournal,
  retryTask,
  taskByAttempt,
  tasksToStart,
  trimHistory,
  type TaskDraft,
} from "./tasks";
import {
  dismissToast,
  EMPTY_TOASTS,
  expireToasts,
  nextToastDeadline,
  pauseToasts,
  pushToast,
  resumeToasts,
  type Toast,
  type ToastAction,
  type ToastPauseReason,
  type ToastTone,
  type ToastsState,
} from "./toasts";

// ---------------------------------------------------------------- 状态形状

export type Slice = "settings" | "accounts" | "instances" | "pins" | "tasks" | "firstRun";
export type SliceStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: Error };

/** 另一实例占着游戏进程时再点启动：外壳据此弹替换确认，回答经 resolveLaunchPrompt 交回。 */
export interface LaunchPrompt {
  instanceId: string;
  occupantId: string;
  occupantPhase: "loading" | "running";
}

/** 新建实例的入参。cover 为封面预设 id。 */
export interface CreateInstanceSpec {
  name: string;
  mcVersion: string;
  loader: LoaderKind;
  /** 原版为 null；带加载器时必填。 */
  loaderVersion: string | null;
  cover: string;
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
  | { type: "repair"; launchAfter: boolean }
  /** pinFor：下载完把这个实例的 Java 固定为新装的运行时（崩溃诊断「下载 Java N」）。 */
  | { type: "java"; major: number; launchAfter: string | null; pinFor: string | null }
  | { type: "mods"; instanceId: string; name: string; dependencies: number }
  | { type: "resource"; instanceId: string; resourceType: InstallableResourceType; name: string }
  | { type: "update"; instanceId: string; name: string }
  | { type: "updates"; instanceId: string };

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
  refreshAccount(uuid: string): Promise<"refreshed" | "expired">;
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
  previewInstanceDeletion(id: string): Promise<DeletionPreviewDto>;
  deleteInstance(id: string, worldCount: number): Promise<void>;
  renameInstance(id: string, name: string): Promise<string>;
  updateInstanceSettings(id: string, patch: Partial<InstanceSettings>): Promise<InstanceSettings>;
  repairInstance(id: string, opts?: { launchAfter?: boolean }): Promise<void>;
  openFolder(target: FolderTarget, id?: string | null, world?: string | null): Promise<void>;
  /** 用系统默认浏览器打开一个 http(s) 网址；别的协议直接抛错。打开失败原样抛出。 */
  openExternal(url: string): Promise<void>;
  refreshInstances(): Promise<void>;
  // 启动会话
  launch(id: string): Promise<void>;
  stop(): Promise<void>;
  dismissSession(): void;
  resolveLaunchPrompt(accept: boolean): Promise<void>;
  /** 当前启动失败会话的修复动作落点；会话不是 failed 时抛错。 */
  failureFix(kind: FailureFixKind): FailureFixTarget;
  // Mod 与资源
  toggleMod(instanceId: string, fileName: string, enabled: boolean): Promise<void>;
  updateMod(instanceId: string, fileName: string): Promise<void>;
  updateAllMods(instanceId: string): Promise<void>;
  removeMod(instanceId: string, fileName: string, name: string): Promise<void>;
  installResource(spec: InstallResourceSpec): Promise<void>;
  rollback(instanceId: string, eventId: string): Promise<void>;
  /** launchAfter：装好后通知带「启动」这个实例；pinFor：装好后把这个实例的 Java 固定为新装的运行时。 */
  installJava(major: number, opts?: { launchAfter?: string; pinFor?: string }): Promise<void>;
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
]);

/**
 * 实例列表里带着结果的实例设置，改了要重扫列表：简介与封面直接显示；隔离会换掉工作目录，列表里的隔离生效值、
 * 存档数与 Mod 数随之变；自定内存直接给出 memoryMb。
 */
const LISTED_INSTANCE_SETTINGS = ["description", "cover", "isolation", "memoryMb"] as const;

/** 写整个实例目录的任务：期间实例算「安装中」。其余挂在实例上的任务（装、更新 Mod 与资源）只改动其中的 Mod 与资源，算 modifying。 */
const INSTANCE_TASKS = new Set(["install_version", "install_modpack", "repair_instance"]);

/** 前端的组合任务：逐项调后端命令，中途失败或取消时前面几项已经落盘。 */
const COMPOSITE_TASKS = new Set(["install_mods", "update_mods"]);

/** opener 插件打开网址的命令（能力里已授予 opener:allow-open-url，默认作用域放行 http 与 https）。 */
const OPEN_URL_COMMAND = "plugin:opener|open_url";

/** refresh_account 判定凭据失效、只能重新登录时的错误码（aurora-auth 的变体名）。 */
const RELOGIN_REQUIRED_CODE = "ReloginRequired";

/** load_task_journal 在日志文件损坏或版本不符时的错误码。 */
const TASK_JOURNAL_INVALID_CODE = "task_journal_invalid";

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
    unseenFailures: [],
    toasts: EMPTY_TOASTS,
    login: null,
    launchPrompt: null,
    lastRename: null,
  };
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
      };
    case "install_modpack":
      return { type: "modpack", name: strArg(args, "name", command), cover: null, modCount: null, mcVersion: null, loader: "vanilla", loaderVersion: null };
    case "repair_instance":
      return { type: "repair", launchAfter: false };
    case "install_java": {
      const major = args.requiredMajor;
      if (typeof major !== "number") throw new Error("任务 install_java 缺少 requiredMajor");
      return { type: "java", major, launchAfter: null, pinFor: null };
    }
    case "install_mods": {
      const items = modItems(args);
      return { type: "mods", instanceId: strArg(args, "versionId", command), name: items[0].title, dependencies: items.length - 1 };
    }
    case "update_mods":
      return { type: "updates", instanceId: strArg(args, "versionId", command) };
    default:
      return null;
  }
}

interface ModItem {
  platform: Platform;
  projectId: string;
  modVersionId: string;
  title: string;
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
    };
  });
}

interface UpdateItem {
  fileName: string;
  platform: Platform;
  projectId: string;
  modVersionId: string;
  /** Mod 名（完成通知用）；较早写入任务日志的记录没有这一项，为 null。 */
  title: string | null;
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
    };
  });
}

/** 「全部更新」这一次尝试实际换掉的 Mod（重试时只含这一次换的）。 */
interface UpdatesOutcome {
  updated: UpdateItem[];
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

/** 命令参数里指向实例的那一项：失败任务重试时按它重新调用命令。 */
const INSTANCE_ARG: Readonly<Record<string, string>> = {
  repair_instance: "id",
  install_mod: "versionId",
  install_mods: "versionId",
  install_resource: "versionId",
  update_mod: "versionId",
  update_mods: "versionId",
};

/**
 * 实例改名后任务里的实例 id 一并换掉：任务行的「查看实例」、重试时重新调用的命令参数都要指向新名字。
 * 后端在实例有活动任务时拒绝改名，所以这里换的只是已结束的任务（失败的可以重试）。
 */
function renamedTask(task: Task, from: string, to: string): Task {
  if (task.instanceId !== from) return task;
  const key = INSTANCE_ARG[task.spec.command];
  const args = key !== undefined && task.spec.args[key] === from ? { ...task.spec.args, [key]: to } : task.spec.args;
  return { ...task, instanceId: to, spec: { ...task.spec, args } };
}

/** 入队上下文里指向实例的字段：落地时的失效、通知文案与装好后的启动、固定都按它走。 */
function renamedMeta(meta: TaskMeta, from: string, to: string): TaskMeta {
  const swap = (value: string | null) => (value === from ? to : value);
  switch (meta.type) {
    case "mods":
    case "resource":
    case "update":
    case "updates":
      return meta.instanceId === from ? { ...meta, instanceId: to } : meta;
    case "java":
      return meta.launchAfter === from || meta.pinFor === from ? { ...meta, launchAfter: swap(meta.launchAfter), pinFor: swap(meta.pinFor) } : meta;
    case "create":
    case "modpack":
    case "repair":
      return meta;
  }
}

// ---------------------------------------------------------------- 派生

function countUnseen(tasks: readonly Task[], unseen: readonly string[]): number {
  if (unseen.length === 0) return 0;
  const ids = new Set(unseen);
  return tasks.filter((t) => t.status === "failed" && ids.has(attemptTaskId(t))).length;
}

/** 活动任务对一个已扫描实例的影响：整个目录在写（安装中），或者只在改动 Mod 与资源。 */
type TaskEffect = "installing" | "modifying" | null;

function applyTaskEffect(base: InstanceSummary, pinned: boolean, effect: TaskEffect): InstanceSummary {
  if (effect === "installing") return { ...base, pinned, status: "installing", brokenReason: null };
  // 列表是任务开始前扫的，后端那时还没记下占用；后端报的活动（例如运行中）比前端推断的更准，留着它。
  if (effect === "modifying") return { ...base, pinned, activity: base.activity === null ? "modifying" : base.activity };
  return { ...base, pinned };
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
    description: null,
    cover: meta.cover,
    pinned,
    status: "installing",
    brokenReason: null,
    createdAt,
    lastPlayedAt: null,
    playtimeMin: 0,
    modCount: null,
    worldCount: null,
    isolated: null,
    memoryMb: null,
    modpack: null,
    modpackError: null,
    lastCrashAt: null,
    lastCrashError: null,
    activity: "installing",
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
 * - 必须重算时按实例增量：一个实例的扫描结果、固定与否、活动任务带来的状态（安装中或改动中）都没变，就复用上一次的那个对象。
 */
class StateDeriver {
  private lastInputs: { scanned: InstanceSummary[]; pins: string[]; taskMeta: RawState["taskMeta"]; activeKey: string } | null = null;
  private lastView: InstancesView | null = null;
  private scannedCache = new Map<string, { base: InstanceSummary; pinned: boolean; effect: TaskEffect; value: InstanceSummary }>();
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
      last.activeKey === activeKey
    ) {
      return this.lastView;
    }
    const view = this.compute(raw, active);
    this.lastInputs = { scanned: raw.scanned, pins: raw.pins, taskMeta: raw.taskMeta, activeKey };
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
    const modifying = new Set<string>();
    for (const t of active) {
      if (t.instanceId === null) continue;
      (INSTANCE_TASKS.has(t.spec.command) ? installing : modifying).add(t.instanceId.toLowerCase());
    }
    const scannedCache = new Map<string, { base: InstanceSummary; pinned: boolean; effect: TaskEffect; value: InstanceSummary }>();
    const instances: InstanceSummary[] = raw.scanned.map((base) => {
      const key = base.id.toLowerCase();
      const effect: TaskEffect = installing.has(key) ? "installing" : modifying.has(key) ? "modifying" : null;
      const pinned = raw.pins.includes(base.id);
      const cached = this.scannedCache.get(base.id);
      const value =
        cached !== undefined && cached.base === base && cached.pinned === pinned && cached.effect === effect
          ? cached.value
          : applyTaskEffect(base, pinned, effect);
      scannedCache.set(base.id, { base, pinned, effect, value });
      return value;
    });
    this.scannedCache = scannedCache;

    const known = new Set(instances.map((i) => i.id.toLowerCase()));
    const sidebarPins = [...raw.pins];
    const placeholderCache = new Map<string, { meta: TaskMeta; createdAt: number; pinned: boolean; value: InstanceSummary }>();
    for (const task of active) {
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
  private failureBatch: { toastId: string; startedAt: number; reasons: string[] } | null = null;
  private renameSeq = 0;
  /**
   * 任务日志读没读出来。unread 期间（首查进行中，或读失败、还可能读出来）不写回：写回会用内存里的表覆盖那份没读到的历史。
   * invalid 是文件损坏或版本不符，内容本来就救不回来，照常写回，免得任务表从此再也存不下来。
   */
  private journalState: "unread" | "read" | "invalid" = "unread";
  /** 首次启动向导的第一步已经提交（后端已记下向导完成）。 */
  private firstRunCommitted = false;
  /**
   * 已请求取消、还没落定的尝试（attemptTaskId）。后端只记「取消时不在运行」的 id：组合任务的某一项在取消宽限期内
   * 照常做完时按成功返回，同一个 id 再登记拿到的是全新的令牌，下一项会照常开始。所以取消要由前端记着，每开始一项前查一次。
   */
  private readonly cancelRequested = new Set<string>();
  /**
   * 实例正在被删除、完成后不再落地的任务（任务 id）。删除前取消它们，但取消可能没赶上：任务在取消宽限期内照常做完时，
   * 写封面、写固定、弹「已就绪」都是对一个马上要删掉的实例做的，提示也会和结果对不上。
   */
  private readonly discardLanding = new Set<string>();
  /** 固定服务器的读改写排成一条链：两次切换并发时，后一次要等前一次写完再读，否则先写的那台会被后写的覆盖。 */
  private serverPinChain: Promise<void> = Promise.resolve();

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
    this.raw = { ...this.raw, ...next };
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

  private async fetchSettings(): Promise<void> {
    this.set({ settings: settingsFromDto(await configIpc.getConfig()) });
  }

  private async fetchAccounts(): Promise<void> {
    const [list, current] = await Promise.all([accountsIpc.listAccounts(), accountsIpc.currentAccount()]);
    this.set({ accounts: list.map(accountFromDto), currentAccountId: current === null ? null : current.uuid });
  }

  private async fetchInstances(extra?: (raw: RawState, scanned: InstanceSummary[]) => Partial<RawState>): Promise<void> {
    const dtos: InstanceDto[] = await instancesIpc.listInstances();
    const scanned = dtos.map((dto) => instanceFromDto(dto, { pins: [], busyTaskInstanceIds: new Set() }));
    this.lastScanAt = Date.now();
    this.set((raw) => ({ scanned, ...(extra === undefined ? {} : extra(raw, scanned)) }));
  }

  private async fetchPins(): Promise<void> {
    this.set({ pins: await instancesIpc.getSidebarPins() });
  }

  /**
   * 读任务日志并恢复上次的任务：上次没完成的记为「关闭时中断」。日志读不出来时用户照样能入队，所以重试读取时
   * 内存里已有的任务优先，原样保留，只把日志里内存没有的那些并进来；读到过一次之后内存就是准的，再读不改任务表。
   */
  private async fetchJournal(): Promise<void> {
    const records = await tasksIpc.loadTaskJournal().catch((error: unknown) => {
      if (isIpcError(error) && error.code === TASK_JOURNAL_INVALID_CODE) this.journalState = "invalid";
      throw error;
    });
    if (this.journalState === "read") return;
    const now = Date.now();
    const loaded = records.map(taskFromRecord);
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
    const failed = this.raw.tasks.filter((t) => t.status === "failed").length;
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
   */
  private modsChanged(instanceId: string): void {
    for (const prefix of ["mods", "history", "mod-updates", "plan"]) invalidateResources(`${prefix}:${instanceId}`);
    invalidateResources("match");
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
      this.set((raw) => ({
        tasks: applyTaskDownload(raw.tasks, event.task_id as string, {
          total: event.total,
          finished: event.finished,
          bytes: event.bytes,
          totalBytes: event.total_bytes,
          speed: event.speed,
        }),
      }));
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

  /** 读崩溃报告的主线索，写进会话并发崩溃通知。读不出时会话标为 unavailable，错误照常抛出。 */
  private async announceCrash(instanceId: string): Promise<void> {
    invalidateResources(`crash:${instanceId}`);
    const toCrashPage: ToastAction = { label: TOAST_COPY.viewCrashAction, to: { page: "instance", id: instanceId, tab: "crash" } };
    const setClue = (crash: SessionCrash) => {
      const s = this.raw.session;
      if (s !== null) this.set({ session: sessionCrashClue(s, instanceId, crash) });
    };
    const report = await resources.read(`crash:${instanceId}`, () => lastCrash(instanceId)).catch((error: unknown) => {
      setClue({ status: "unavailable" });
      this.pushToast("error", TOAST_COPY.crashed(instanceId), undefined, toCrashPage);
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
    this.pushToast("error", TOAST_COPY.crashed(instanceId), body, toCrashPage);
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
    await tasksIpc.saveTaskJournal(this.raw.tasks.map(taskToRecord));
  }

  private pump(): void {
    for (const task of tasksToStart(this.raw.tasks)) {
      this.set((raw) => ({ tasks: markRunning(raw.tasks, task.id, Date.now()) }));
      const attempt = task.attempt;
      const attemptId = attemptTaskId(task);
      this.execute(task).then(
        (result) => {
          this.cancelRequested.delete(attemptId);
          this.onTaskDone(task.id, attempt, result);
        },
        (error: unknown) => {
          this.cancelRequested.delete(attemptId);
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

  private assertNotCancelled(attemptId: string): void {
    if (this.cancelRequested.has(attemptId)) throw new IpcError(CANCELLED_ERROR_CODE, "已取消");
  }

  private async execute(task: Task): Promise<unknown> {
    const taskId = attemptTaskId(task);
    const { command, args } = task.spec;
    if (!TASK_COMMANDS.has(command)) throw new Error(`任务日志里有不可重放的命令：${command}`);
    // 组合任务逐个调后端命令，复用同一个 taskId；每开始一项前查一次取消（见 cancelRequested）
    if (command === "install_mods") {
      const versionId = strArg(args, "versionId", command);
      for (const item of modItems(args)) {
        this.assertNotCancelled(taskId);
        await installMod(taskId, versionId, item.platform, item.projectId, item.modVersionId);
      }
      return null;
    }
    if (command === "update_mods") {
      const versionId = strArg(args, "versionId", command);
      const updated: UpdateItem[] = [];
      for (const item of task.attempt > 1 ? await this.pendingUpdates(versionId, updateItems(args)) : updateItems(args)) {
        this.assertNotCancelled(taskId);
        await modsIpc.updateMod(taskId, versionId, item.fileName, item.modVersionId);
        updated.push(item);
      }
      const outcome: UpdatesOutcome = { updated };
      return outcome;
    }
    return invoke<unknown>(command, { ...args, taskId });
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

  private findTask(id: string): Task {
    const task = this.raw.tasks.find((t) => t.id === id);
    if (task === undefined) throw new Error(`没有任务 ${id}`);
    return task;
  }

  private metaOf(task: Task): TaskMeta | null {
    const meta = this.raw.taskMeta[task.id];
    return meta === undefined ? metaFromSpec(task) : meta;
  }

  private onTaskDone(id: string, attempt: number, result: unknown): void {
    const before = this.findTask(id);
    if (before.status !== "running" || before.attempt !== attempt) return;
    this.set((raw) => ({ tasks: trimHistory(markDone(raw.tasks, id, attempt, Date.now())) }));
    this.tasksChanged();
    if (this.discardLanding.has(id)) return;
    this.background(ACTION_ERROR.landTask(before.title), this.landTask(before, result));
  }

  private onTaskFailed(id: string, attempt: number, error: unknown): void {
    const before = this.findTask(id);
    if (before.status !== "running" || before.attempt !== attempt) return;
    if (isCancelled(error)) {
      this.set((raw) => ({ tasks: trimHistory(markCancelled(raw.tasks, id, Date.now())) }));
      this.pushToast("info", TASK_TOAST.cancelled(before.title).title);
    } else {
      console.error(`任务失败：${before.title}`, error);
      this.net.reportFailure(error);
      const record = errorRecord(error);
      this.set((raw) => ({
        tasks: trimHistory(markFailed(raw.tasks, id, attempt, record, Date.now())),
        unseenFailures: [...raw.unseenFailures, attemptTaskId(before)],
      }));
      this.failureToast(before, taskFailureReason(record));
    }
    this.tasksChanged();
    // 新建与导入取消后后端删除实例，修复失败或取消后实例带着未完成标记，都要重扫
    if (INSTANCE_TASKS.has(before.spec.command)) this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    // 组合任务停下之前做完的那几项已经落盘，Mod 列表与数目不能停在任务开始前
    if (COMPOSITE_TASKS.has(before.spec.command) && before.instanceId !== null) {
      this.modsChanged(before.instanceId);
      this.background(ACTION_ERROR.refreshInstances, this.fetchInstances());
    }
  }

  /** 单个失败一条「下载失败」；10 s 内再有失败合并成一条「n 个下载失败」，操作改为查看失败筛选。 */
  private failureToast(task: Task, reason: string): void {
    const now = Date.now();
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
    const toastId = this.pushToast("error", single.title, single.body, {
      label: TASK_TOAST.retryAction,
      run: () => this.actions.retryTask(task.id),
      errorTitle: ACTION_ERROR.install,
    });
    this.failureBatch = { toastId, startedAt: now, reasons: [reason] };
  }

  private withRunningSuffix(instanceId: string, body: string): string {
    return this.sessionActiveFor(instanceId) ? `${body}${NEXT_LAUNCH_SUFFIX}` : body;
  }

  private launchAction(instanceId: string): ToastAction {
    return { label: TASK_TOAST.launchAction, run: () => this.actions.launch(instanceId), errorTitle: ACTION_ERROR.launch(instanceId) };
  }

  /** 新建、导入的实例：写封面；要固定且侧栏此刻没满时追加到固定列表末尾。 */
  private async settleNewInstance(id: string, cover: string | null, pin: boolean): Promise<void> {
    if (cover !== null) {
      const current = instanceSettingsFromDto(await instancesIpc.getInstanceSettings(id));
      await instancesIpc.setInstanceSettings(id, instanceSettingsToDto({ ...current, cover }));
    }
    const pins = this.raw.pins;
    if (pin && pins.length < SIDEBAR_PIN_LIMIT && !pins.includes(id)) this.set({ pins: await instancesIpc.setSidebarPins([...pins, id]) });
    await this.fetchInstances();
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
      return;
    }
    switch (meta.type) {
      case "create": {
        const id = (result as InstallResultDto).id;
        await this.settleNewInstance(id, meta.cover, meta.autoPin);
        const copy = TASK_TOAST.ready(id);
        this.pushToast("success", copy.title, copy.body, this.launchAction(id));
        return;
      }
      case "modpack": {
        const id = (result as ModpackInstallOutcomeDto).version_id;
        await this.settleNewInstance(id, meta.cover, true);
        // 重启后恢复的导入任务不知道 Mod 数，正文省略
        const copy = TASK_TOAST.imported(id, meta.modCount);
        this.pushToast("success", copy.title, "body" in copy ? copy.body : undefined, this.launchAction(id));
        return;
      }
      case "repair": {
        const id = strArg(task.spec.args, "id", command);
        await this.fetchInstances();
        if (meta.launchAfter && !isSessionActive(this.raw.session)) {
          await this.actions.launch(id);
          return;
        }
        this.pushToast("success", TASK_TOAST.repaired(id).title, undefined, this.launchAction(id));
        return;
      }
      case "java": {
        const runtime = result as InstalledRuntimeDto;
        this.set((raw) => ({ tasks: raw.tasks.map((t) => (t.id === task.id ? { ...t, detail: TASK_TEXT.javaDetail(runtime.version.raw) } : t)) }));
        this.scheduleJournal();
        invalidateResources("java");
        if (meta.pinFor !== null) await this.actions.updateInstanceSettings(meta.pinFor, { java: runtime.java_executable });
        const copy = meta.pinFor === null ? TASK_TOAST.java(meta.major) : TASK_TOAST.javaPinned(meta.major, meta.pinFor);
        this.pushToast("success", copy.title, copy.body, meta.launchAfter === null ? undefined : this.launchAction(meta.launchAfter));
        return;
      }
      case "mods": {
        this.modsChanged(meta.instanceId);
        await this.fetchInstances();
        const copy = TASK_TOAST.modInstalled(meta.name, meta.dependencies, meta.instanceId);
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
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
        return;
      }
      case "updates": {
        // 重试时上一次尝试已经换掉的不再计入：通知只说这一次实际换了什么
        const { updated } = result as UpdatesOutcome;
        this.modsChanged(meta.instanceId);
        if (updated.length === 0) {
          const latest = TASK_TOAST.modsAlreadyLatest(meta.instanceId);
          this.pushToast("info", latest.title, latest.body);
          return;
        }
        const only = updated.length === 1 ? updated[0].title : null;
        const copy = only === null ? TASK_TOAST.modsUpdated(updated.length, meta.instanceId) : TASK_TOAST.modUpdated(only, meta.instanceId);
        this.pushToast("success", copy.title, this.withRunningSuffix(meta.instanceId, copy.body));
        return;
      }
    }
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
      await this.actions.launch(intent.instanceId);
      return;
    }
    this.pushToast("success", toast.title, toast.body);
  }

  // ---------------------------------------------------------------- 启动内部

  private async startLaunch(instanceId: string, account: Account): Promise<void> {
    const taskId = freshId("launch");
    this.set({ session: startSession(instanceId, taskId, account, Date.now()), launchPrompt: null });
    if (this.raw.settings !== null && this.raw.settings.selectedVersion !== instanceId) {
      this.background(ACTION_ERROR.selectInstance, this.actions.selectInstance(instanceId));
    }
    // 启动的结局（失败码、取消）是会话状态的一部分，不是异常：在这里转成会话；其余错误清掉乐观会话后原样抛出
    await launchIpc.launchGame({ taskId, versionId: instanceId, accountUuid: account.uuid, offlineName: null }).then(
      () => {
        const s = this.raw.session;
        if (s !== null) this.set({ session: sessionLaunched(s, taskId, Date.now()) });
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
        this.set({ session: null });
        throw error;
      },
    );
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
    const copy = failureCopy(code, params, { accountName: s.accountName, javaPinned: false });
    const action: ToastAction = { label: copy.fix.label, ...this.fixTarget(failed, copy.fix.kind) };
    this.pushToast("error", TOAST_COPY.launchFailed(s.instanceId), copy.title, action);
  }

  /** 启动失败的修复动作落到哪里：导航类给路由，命令类给要执行的函数。失败通知与启动入口共用这一份映射。 */
  private fixTarget(s: SessionState, kind: FailureFixKind): FailureFixTarget {
    const instanceId = s.instanceId;
    switch (kind) {
      case "retry":
        return { run: () => this.actions.launch(instanceId), errorTitle: ACTION_ERROR.launch(instanceId) };
      case "repair":
        return { run: () => this.actions.repairInstance(instanceId), errorTitle: ACTION_ERROR.repair };
      case "download_java": {
        const major = s.failure === null ? undefined : s.failure.params.major;
        if (typeof major !== "number") throw new Error("java_missing 缺少 major");
        return { run: () => this.actions.installJava(major, { launchAfter: instanceId }), errorTitle: ACTION_ERROR.installJava };
      }
      case "auto_java":
        return {
          run: async () => {
            await this.actions.updateInstanceSettings(instanceId, { java: JAVA_AUTO });
            await this.actions.launch(instanceId);
          },
          errorTitle: ACTION_ERROR.launch(instanceId),
        };
      case "relogin": {
        const accountUuid = s.accountUuid;
        return { run: () => this.actions.relogin(accountUuid, { kind: "launch", instanceId }), errorTitle: ACTION_ERROR.relogin };
      }
      case "open_game_dir":
        return { run: () => this.actions.openFolder("game_dir"), errorTitle: ACTION_ERROR.openFolder };
      case "open_logs":
        return { to: { page: "instance", id: instanceId, tab: "logs" } };
      case "pick_java":
        return { to: { page: "instance", id: instanceId, tab: "settings" } };
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
            throw error;
          },
        );
        await store.fetchAccounts();
        if (outcome === "refreshed") invalidateResources(`skin:${uuid}`);
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
              device: { status: "failed", code: DEVICE_CODE_TIMEOUT_CODE, message: `${DEVICE_CODE_FETCH_TIMEOUT_MS / 1000} 秒内没有收到设备码`, detail: null },
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
        await configIpc.updateConfig({ selectedVersion: id });
        store.set((raw) => ({ settings: raw.settings === null ? null : { ...raw.settings, selectedVersion: id } }));
      },
      async togglePin(id) {
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
        store.set({ pins: await instancesIpc.setSidebarPins(next) });
      },
      async setSidebarPins(ids) {
        // 安装中自动固定的新实例总排在末尾，不写进固定列表（装好后才写）
        const persisted = ids.filter((id) => store.pendingCreate(id) === null);
        const before = store.raw.pins;
        store.set({ pins: persisted });
        // 拖动排序先乐观改顺序；写入失败恢复原顺序后把错误原样交给外层
        try {
          store.set({ pins: await instancesIpc.setSidebarPins(persisted) });
        } catch (error) {
          store.set({ pins: before });
          throw error;
        }
      },
      async createInstance(spec) {
        const nameError = instanceNameError(spec.name, store.instanceIds());
        if (nameError !== null) throw new Error(nameError);
        if (spec.loader !== "vanilla" && spec.loaderVersion === null) throw new Error(`${spec.loader} 实例需要加载器版本`);
        const loader = spec.loader === "vanilla" ? null : spec.loader;
        const autoPin = store.getState().sidebarPins.length < SIDEBAR_PIN_LIMIT;
        const task = store.enqueue(
          {
            kind: "game",
            title: TASK_TEXT.createTitle(spec.mcVersion, spec.loader, spec.loaderVersion),
            detail: TASK_TEXT.createDetail(spec.name),
            instanceId: spec.name,
            spec: { command: "install_version", args: { id: spec.mcVersion, loader, loaderVersion: loader === null ? null : spec.loaderVersion, targetName: spec.name } },
          },
          { type: "create", name: spec.name, mcVersion: spec.mcVersion, loader: spec.loader, loaderVersion: spec.loaderVersion, cover: spec.cover, autoPin },
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
            spec: { command: "install_modpack", args: { source: spec.source, name: spec.name } },
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
      async previewInstanceDeletion(id) {
        return instancesIpc.previewInstanceDeletion(id);
      },
      async deleteInstance(id, worldCount) {
        if (store.sessionActiveFor(id)) throw new Error(`「${id}」的游戏正在运行，先结束游戏`);
        // 取消排队中的新建任务后占位项随之消失，先记下它是不是占位
        const placeholder = store.instance(id).placeholder;
        const doomed = store.raw.tasks.filter((t) => isActiveTask(t) && t.instanceId === id).map((t) => t.id);
        for (const taskId of doomed) store.discardLanding.add(taskId);
        try {
          await store.cancelInstanceTasks(id);
          // 占位实例的取消没赶上时（安装在宽限期内做完，或取消到达前就失败、留下了未完成的目录），实例已经在盘上，
          // 照样要删；赶上了的，后端已经删掉半成品。重扫一次按盘上的实际情况定
          if (placeholder) await store.fetchInstances();
          if (!placeholder || store.raw.scanned.some((i) => i.id === id)) await instancesIpc.deleteInstance(id);
        } finally {
          for (const taskId of doomed) store.discardLanding.delete(taskId);
        }
        const s = store.raw.session;
        if (s !== null && s.instanceId === id) store.set({ session: null });
        await Promise.all([store.fetchInstances(), store.fetchPins(), store.fetchSettings()]);
        for (const prefix of ["mods", "content", "history", "crash", "log", "settings", "mod-updates"]) invalidateResources(`${prefix}:${id}`);
        const copy = TOAST_COPY.instanceDeleted(id, worldCount);
        store.pushToast("info", copy.title, copy.body);
      },
      async renameInstance(id, name) {
        const nameError = instanceNameError(name, store.instanceIds(), id);
        if (nameError !== null) throw new Error(nameError);
        const { id: newId } = await instancesIpc.renameInstance(id, name);
        await Promise.all([store.fetchPins(), store.fetchSettings()]);
        store.renameSeq += 1;
        const seq = store.renameSeq;
        // 已结束的失败、崩溃会话不算占用，允许改名；它的修复动作与「查看诊断」都按会话里的实例 id 走，必须一起迁过去
        await store.fetchInstances((raw) => ({
          lastRename: { from: id, to: newId, seq },
          tasks: raw.tasks.map((t) => renamedTask(t, id, newId)),
          taskMeta: Object.fromEntries(Object.entries(raw.taskMeta).map(([taskId, meta]) => [taskId, renamedMeta(meta, id, newId)])),
          session: raw.session !== null && raw.session.instanceId === id ? { ...raw.session, instanceId: newId } : raw.session,
          launchPrompt:
            raw.launchPrompt === null
              ? null
              : {
                  ...raw.launchPrompt,
                  instanceId: raw.launchPrompt.instanceId === id ? newId : raw.launchPrompt.instanceId,
                  occupantId: raw.launchPrompt.occupantId === id ? newId : raw.launchPrompt.occupantId,
                },
        }));
        store.scheduleJournal();
        return newId;
      },
      async updateInstanceSettings(id, patch) {
        const current = instanceSettingsFromDto(await instancesIpc.getInstanceSettings(id));
        const saved = instanceSettingsFromDto(await instancesIpc.setInstanceSettings(id, instanceSettingsToDto({ ...current, ...patch })));
        invalidateResources(`settings:${id}`);
        if (LISTED_INSTANCE_SETTINGS.some((key) => key in patch)) await store.fetchInstances();
        return saved;
      },
      async repairInstance(id, opts = {}) {
        const inst = store.instance(id);
        if (store.sessionActiveFor(id)) throw new Error(`「${id}」的游戏正在运行，先结束游戏`);
        const spec = inst.incomplete === null ? null : inst.incomplete.spec;
        const mcVersion = inst.mcVersion !== null ? inst.mcVersion : spec === null ? null : spec.mcVersion;
        const detail =
          mcVersion === null
            ? TASK_TEXT.repairDetailUnknown
            : inst.mcVersion !== null
              ? TASK_TEXT.repairDetail(mcVersion, inst.loader, inst.loaderVersion)
              : TASK_TEXT.repairDetail(mcVersion, loaderOfArg(spec === null ? null : spec.loader), spec === null ? null : spec.loaderVersion);
        store.enqueue(
          { kind: "repair", title: TASK_TEXT.repairTitle(id), detail, instanceId: id, spec: { command: "repair_instance", args: { id } } },
          { type: "repair", launchAfter: opts.launchAfter === true },
          id,
        );
      },
      async openFolder(target, id = null, world = null) {
        await instancesIpc.openFolder(target, id, world);
      },
      async openExternal(url) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`只能打开 http(s) 网址：${url}`);
        // 交给 opener 插件的命令而不是 target="_blank" 的链接：注入脚本接管链接点击时不等结果，打开失败就悄悄没了
        await invoke<void>(OPEN_URL_COMMAND, { url: parsed.href });
      },
      async refreshInstances() {
        await store.fetchInstances();
      },

      // ---- 启动会话
      async launch(id) {
        const inst = store.instance(id);
        const s = store.raw.session;
        if (s !== null && isSessionActive(s)) {
          // 同一实例在多个入口上点启动，只有第一次生效
          if (s.instanceId === id) return;
          store.set({ launchPrompt: { instanceId: id, occupantId: s.instanceId, occupantPhase: s.phase === "running" ? "running" : "loading" } });
          return;
        }
        if (inst.status === "installing") throw new Error(`「${id}」还在安装，入口不应提供启动`);
        if (inst.status === "broken") {
          await actions.repairInstance(id, { launchAfter: true });
          return;
        }
        const account = store.currentAccount();
        if (account === null) {
          store.set({ login: { kind: "no_account", intent: { kind: "launch", instanceId: id } } });
          return;
        }
        await store.startLaunch(id, account);
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
        await actions.launch(prompt.instanceId);
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
      async updateAllMods(instanceId) {
        store.assertModsEditable(instanceId);
        const candidates = await modsIpc.checkUpdates(instanceId);
        if (candidates.length === 0) {
          store.pushToast("info", TOAST_COPY.allModsLatest);
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
      async installResource(spec) {
        const enqueued: string[] = [];
        for (const target of spec.targets) {
          if (spec.resourceType === "mod") {
            const plan = await modsIpc.planInstall(target.instanceId, spec.platform, spec.projectId, target.fileVersionId);
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
        const duplicate = findDuplicate(store.raw.tasks, task.spec);
        if (duplicate !== undefined) {
          store.pushToast("info", TASK_TOAST.duplicate(task.title).title);
          return;
        }
        store.set((raw) => ({ tasks: retryTask(raw.tasks, id) }));
        store.tasksChanged();
      },
      retryFailedTasks() {
        let retried = 0;
        for (const task of store.raw.tasks.filter((t) => t.status === "failed")) {
          // 逐个排：前一个重试后，同一件事的后一个就算重复
          if (findDuplicate(store.raw.tasks, task.spec) !== undefined) continue;
          store.set((raw) => ({ tasks: retryTask(raw.tasks, task.id) }));
          retried += 1;
        }
        if (retried > 0) store.tasksChanged();
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
      async setGameDirectory(path) {
        await configIpc.setGameDirectory(path);
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
        const run = store.serverPinChain.then(async () => {
          const current = await listPinnedServers();
          const pinned = current.some((s) => s.address === server.address);
          await setPinnedServers(pinned ? current.filter((s) => s.address !== server.address) : [...current, server]);
          invalidateResources("servers");
        });
        // 链只负责排队：这一次的失败经下面的 await 照常抛给调用方，不挡后面排着的切换
        store.serverPinChain = run.then(
          () => undefined,
          () => undefined,
        );
        await run;
      },
      async reload(slice) {
        await store.loadSlice(slice);
      },
    };
    return actions;
  }

  private async afterAuthlib(account: Account): Promise<void> {
    if (account.authServer === null) throw new Error(`外置登录账户 ${account.name} 缺少服务器名`);
    invalidateResources(`skin:${account.uuid}`);
    const copy = TOAST_COPY.authlibAdded(account.name, account.authServer);
    await this.afterAccountAdded("authlib", this.loginIntent("authlib"), copy);
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
