// 引导程序的状态机：纯函数，不碰 bridge、不碰时间。异步的部分（探测、查进程、安装、轮询）都在 App.tsx，
// 结果作为事件送进来。判定「已安装到底是什么情况」全在 Rust 的 probe，这里只把结果映射到视图。
//
// 事件可能晚到：查进程的回包、进度事件都可能在视图已经变了之后才到，所以当前视图不接受的事件一律原样返回状态，
// 不当错误处理。这也是防重复点击的最后一道：第二次「安装」落在 installing 上什么都不会发生。

import { APP_NAME_EN } from "../lib/app-info";
import type { Channel, DataBlock, DirCheck, DirIssue, Existing, Failure, FailureCode, InstallMode, InstallPlan, Probe, Progress } from "./contract";

export type View = "boot" | "preparing" | "welcome" | "location" | "installed" | "blocked" | "installing" | "done" | "failed" | "legal" | "fatal";

/** 能发起安装的视图：失败后重试时回到的仍是这几个。 */
export type InstallOrigin = "welcome" | "location" | "installed";

export interface SetupState {
  view: View;
  probe: Probe | null;
  /** 首装目录：欢迎页和选目录页显示的就是它。 */
  dir: string;
  desktopShortcut: boolean;
  /** 发起安装时目录没过校验的结果：退回选目录页时直接显示这条问题，不等防抖。改了目录就作废。 */
  dirCheck: DirCheck | null;
  plan: InstallPlan | null;
  /** 完成页要不要说「设置、账户和游戏文件都还在」：覆盖安装，或者首装到一个已有 config.json 的目录。 */
  keptData: boolean;
  origin: InstallOrigin;
  /** 第几次进入 installing：App 据此保证每次只调一遍 install，进度条据此换轨道。 */
  run: number;
  progress: Progress | null;
  failure: Failure | null;
  /** 协议页返回到哪里。 */
  legalReturn: View | null;
  /** 点了打开之后：按钮转加载，等启动器窗口出来再退出。 */
  opening: boolean;
  fatal: string | null;
}

export const initialState: SetupState = {
  view: "boot",
  probe: null,
  dir: "",
  desktopShortcut: true,
  dirCheck: null,
  plan: null,
  keptData: false,
  origin: "welcome",
  run: 0,
  progress: null,
  failure: null,
  legalReturn: null,
  opening: false,
  fatal: null,
};

/** 装回登记目录的模式：不带目录，位置是锁定的。 */
type InPlaceMode = Extract<InstallMode, "upgrade" | "repair" | "switch">;

export type SetupEvent =
  | { type: "probed"; probe: Probe }
  | { type: "open_location" }
  | { type: "leave_location" }
  | { type: "dir_changed"; dir: string }
  | { type: "use_default_dir" }
  | { type: "shortcut_changed"; value: boolean }
  | { type: "install_requested"; mode: "fresh"; running: boolean; check: DirCheck }
  | { type: "install_requested"; mode: InPlaceMode; running: boolean }
  /** 更新模式下等过落樱退出之后：running 是等满时长时它还在不在。 */
  | { type: "update_started"; running: boolean }
  | { type: "launcher_gone" }
  | { type: "blocked_back" }
  | { type: "progress"; progress: Progress }
  | { type: "install_succeeded" }
  | { type: "install_failed"; failure: Failure }
  | { type: "failed_back" }
  | { type: "open_legal" }
  | { type: "close_legal" }
  | { type: "opening_launcher" }
  | { type: "crashed"; detail: string };

/** 协议页入口常驻左栏，但安装中不让走开：那段时间用户该看进度，也回不来半截的状态。 */
const LEGAL_SOURCES: readonly View[] = ["welcome", "location", "installed", "blocked", "done", "failed"];

export function canOpenLegal(view: View): boolean {
  return LEGAL_SOURCES.includes(view);
}

/** 安装阶段不能关窗：中途结束安装包只会留下半套文件。 */
export function canCloseWindow(view: View): boolean {
  return view !== "installing";
}

/** 换步的方向：1 往前走，-1 退回去，0 原地换（只淡入淡出、不位移）。 */
export type StepDirection = -1 | 0 | 1;

/** 换步按哪一页算：准备升级页和安装中是同一页，等落樱退出后进度接着走，不换页。 */
export function stepKey(view: View): string {
  return view === "preparing" ? "installing" : view;
}

/** 失败页、拦截页「返回」落回的那几页。 */
const RETURN_TARGETS: readonly View[] = ["welcome", "location", "installed"];

/** 从 from 换到 to 时新页从哪一侧进来。 */
export function stepDirection(from: View, to: View): StepDirection {
  // 出错不算往前走，也不算退回，原地换上错误原文
  if (stepKey(from) === stepKey(to) || from === "boot" || to === "fatal") return 0;
  // 欢迎页点「更改」：路径原地变成可编辑，两页之间只淡不移
  if ((from === "welcome" && to === "location") || (from === "location" && to === "welcome")) return 0;
  if (to === "legal") return 1;
  if (from === "legal") return -1;
  if ((from === "blocked" || from === "failed") && RETURN_TARGETS.includes(to)) return -1;
  return 1;
}

/**
 * 界面能发起哪几种安装，原样取后端判定表算好的：种类、通道、数据关、发起方式一起才定得下来，前端不自己推。
 * 为空时什么都不能装；后端在安装前还会再核一遍，这里挡住的是不该出现的按钮动作。
 */
export function allowedModes(probe: Probe): readonly InstallMode[] {
  return probe.allowedModes;
}

/** 更新模式下不经页面直接装的模式。 */
export type UnattendedMode = Extract<InstallMode, "upgrade" | "switch">;

/**
 * 更新插件拉起时不问用户、直接装回登记目录用的模式，为 null 时退回交互的页面让用户看清楚再点。
 * 后端只在能升级、或带着换通道开关遇到更慢通道上更早的包时给它；首装、修复都要人在场，给了就是契约坏了。
 */
export function unattendedMode(probe: Probe): UnattendedMode | null {
  const mode = probe.unattended;
  if (mode === null || mode === "upgrade" || mode === "switch") return mode;
  throw new Error(`无人值守只会是 upgrade 或 switch，探测结果给的是 ${mode}`);
}

/**
 * 只有无人值守装完才替用户重新打开，且插件要带了 /R：退回交互流程的那几种情况是用户自己点着装的，
 * 和平常一样停在完成页。提权时不开，理由同完成页：提权启动和普通启动用的是两个数据根。
 */
export function relaunchesAfterUpdate(probe: Probe): boolean {
  return unattendedMode(probe) !== null && probe.update?.relaunch === true && !probe.elevated;
}

/**
 * 状态机照着探测结果自动走的几条契约，探测结果一到就核。对不上时照着走，可能在用户没点的时候装，
 * 或者在数据关拦下时装，所以直接报错进致命错误页，不猜。
 */
function checkProbe(probe: Probe): void {
  const mode = unattendedMode(probe);
  if (mode !== null && probe.update === null) throw new Error(`交互启动的探测结果带了无人值守的模式 ${mode}`);
  if (mode !== null && !probe.allowedModes.includes(mode)) throw new Error(`无人值守的模式 ${mode} 不在允许的模式 [${probe.allowedModes.join(", ")}] 里`);
  if (probe.dataBlock === null) return;
  // 首装探测时还没定目录，数据关由选目录那一步核
  if (probe.existing === null) throw new Error("没有现有安装时探测结果不该带数据拦截");
  if (probe.allowedModes.length > 0) throw new Error(`数据关拦下了，探测结果却允许 [${probe.allowedModes.join(", ")}]`);
}

/** 两边的通道：已装的与这个安装包的。 */
export interface ChannelPair {
  installed: Channel;
  payload: Channel;
}

/**
 * 已安装页是哪一种情形，页面照它挑标题、说明和按钮。
 * closedForUpdate：更新模式下停在这一页，落樱是为这次更新关掉的，说明里要告诉用户可以从这里重新打开。
 */
export type InstalledCase =
  /** 同通道或认不出通道的升级。 */
  | { kind: "upgrade" }
  /** 升到另一个通道上更新的版本，但不算换通道：不写交接记录，之后照设置里选的更新通道检查更新。 */
  | { kind: "cross_upgrade"; channels: ChannelPair }
  /** 「换到」安装包的通道，确认后按 mode 发起：upgrade 是换到更快的通道，switch 是装回更慢通道上更早的版本。 */
  | { kind: "switch_to"; mode: "upgrade" | "switch"; channels: ChannelPair }
  | { kind: "same" }
  | { kind: "broken" }
  /** 已装的更新，什么都不能装；说明按原因挑，跨通道的两种要用两边的通道。 */
  | { kind: "newer"; reason: "same_channel" | "unknown_channel"; closedForUpdate: boolean }
  | { kind: "newer"; reason: "faster_channel" | "slower_channel"; channels: ChannelPair; closedForUpdate: boolean }
  /** 数据关拦下，什么都不能装；太新还是读不懂、谁写的，看 block。 */
  | { kind: "data_blocked"; block: DataBlock; closedForUpdate: boolean };

function channelsOf(probe: Probe, existing: Existing, situation: string): ChannelPair {
  const installed = existing.channel;
  const payload = probe.payloadChannel;
  if (installed === null || payload === null) throw new Error(`${situation}要两边的通道都认得，探测结果是 ${installed} 与 ${payload}`);
  return { installed, payload };
}

/**
 * 种类、newer 的原因、要不要写交接记录都由后端定好，这里只把它们归成页面的几种情形，页面不拿两边的通道自己推。
 * 数据关先于一切：拦下时不论种类，页面上只剩「打开落樱」。
 */
export function installedCase(probe: Probe): InstalledCase {
  const { existing } = probe;
  if (existing === null) throw new Error("没有现有安装，不该进已安装页");
  const closedForUpdate = probe.update !== null;
  if (probe.dataBlock !== null) return { kind: "data_blocked", block: probe.dataBlock, closedForUpdate };
  switch (existing.kind) {
    case "upgrade": {
      // 交接记录只在用户亲手确认换到更快的通道时写，页面就用「换到」的说法
      if (probe.handoff) return { kind: "switch_to", mode: "upgrade", channels: channelsOf(probe, existing, "换到更快的通道") };
      const installed = existing.channel;
      const payload = probe.payloadChannel;
      if (installed !== null && payload !== null && installed !== payload) return { kind: "cross_upgrade", channels: { installed, payload } };
      return { kind: "upgrade" };
    }
    case "switch":
      return { kind: "switch_to", mode: "switch", channels: channelsOf(probe, existing, "换到更慢的通道") };
    case "same":
      return { kind: "same" };
    case "broken":
      return { kind: "broken" };
    case "newer": {
      const reason = probe.newerReason;
      if (reason === null) throw new Error("种类是 newer，探测结果却没给原因");
      if (reason === "faster_channel" || reason === "slower_channel") return { kind: "newer", reason, channels: channelsOf(probe, existing, `newer 的原因 ${reason} `), closedForUpdate };
      return { kind: "newer", reason, closedForUpdate };
    }
  }
}

/**
 * 这次安装是不是换到安装包的通道，是就给出那个通道，安装中与完成页的标题据此说「换到」。
 * switch 总是；upgrade 只有用户在「换到」页上确认的那种算。更新模式里跟着到另一个通道的升级不算：
 * 那是启动器按偏好送来的，偏好由启动器自己管。
 */
export function switchingTo(mode: InstallMode, probe: Probe): Channel | null {
  if (mode !== "switch" && !(mode === "upgrade" && probe.handoff)) return null;
  if (probe.payloadChannel === null) throw new Error(`按 ${mode} 换通道却认不出安装包的通道`);
  return probe.payloadChannel;
}

function requireProbe(state: SetupState): Probe {
  if (state.probe === null) throw new Error(`视图 ${state.view} 需要探测结果，状态里没有`);
  return state.probe;
}

function startInstall(state: SetupState, running: boolean): SetupState {
  return running ? { ...state, view: "blocked" } : { ...state, view: "installing", run: state.run + 1, progress: null, failure: null };
}

// 这几种模式没有快捷方式的选项，NSIS 却总会建一个：传 false 让 Rust 删掉本来没有的，用户删过的不会被装回来
const inPlacePlan = (mode: InPlaceMode): InstallPlan => ({ mode, dir: null, desktopShortcut: false });

function requestInstall(state: SetupState, event: Extract<SetupEvent, { type: "install_requested" }>): SetupState {
  if (state.view !== "welcome" && state.view !== "location" && state.view !== "installed" && state.view !== "failed") return state;
  const probe = requireProbe(state);
  if (!allowedModes(probe).includes(event.mode)) return state;
  const origin = state.view === "failed" ? state.origin : state.view;

  if (event.mode === "fresh") {
    if (event.check.issue !== null) return { ...state, view: "location", dirCheck: event.check, origin };
    const plan: InstallPlan = { mode: "fresh", dir: event.check.normalized, desktopShortcut: state.desktopShortcut };
    return startInstall({ ...state, plan, origin, keptData: event.check.hasConfig }, event.running);
  }
  return startInstall({ ...state, plan: inPlacePlan(event.mode), origin, keptData: true }, event.running);
}

export function reduce(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case "probed": {
      if (state.view !== "boot") return state;
      checkProbe(event.probe);
      const { existing } = event.probe;
      const probed = { ...state, probe: event.probe, dir: existing?.dir ?? event.probe.defaultDir };
      // 直接进准备页，不先闪一下已安装页；也不能留在 boot 等：窗口离开 boot 才显示，探测慢的机器上
      // Rust 的显示兜底会先把一个空窗口顶出来
      if (unattendedMode(event.probe) !== null) return { ...probed, view: "preparing" };
      return { ...probed, view: existing === null ? "welcome" : "installed" };
    }
    case "open_location":
      // 只有首装能选位置：已有安装时位置是锁定的，换位置等于搬数据目录
      return (state.view === "welcome" || state.view === "failed") && requireProbe(state).existing === null ? { ...state, view: "location", failure: null } : state;
    case "leave_location":
      return state.view === "location" ? { ...state, view: "welcome", dirCheck: null } : state;
    case "dir_changed":
      return state.view === "location" ? { ...state, dir: event.dir, dirCheck: null } : state;
    case "use_default_dir":
      return state.view === "location" ? { ...state, dir: requireProbe(state).defaultDir, dirCheck: null } : state;
    case "shortcut_changed":
      return state.view === "location" ? { ...state, desktopShortcut: event.value } : state;
    case "install_requested":
      return requestInstall(state, event);
    case "update_started": {
      // 记作从已安装页发起：失败、拦截页返回时落在那里，重试也照同一个模式走
      if (state.view !== "preparing" || state.probe === null) return state;
      const mode = unattendedMode(state.probe);
      if (mode === null) return state;
      return startInstall({ ...state, plan: inPlacePlan(mode), origin: "installed", keptData: true }, event.running);
    }
    case "launcher_gone":
      return state.view === "blocked" ? startInstall(state, false) : state;
    case "blocked_back":
      return state.view === "blocked" ? { ...state, view: state.origin, plan: null } : state;
    case "progress": {
      if (state.view !== "installing") return state;
      const last = state.progress?.percent ?? 0;
      return { ...state, progress: { ...event.progress, percent: Math.max(last, event.progress.percent) } };
    }
    case "install_succeeded":
      return state.view === "installing" ? { ...state, view: "done" } : state;
    case "install_failed":
      return state.view === "installing" ? { ...state, view: "failed", failure: event.failure } : state;
    case "failed_back":
      return state.view === "failed" ? { ...state, view: state.origin, failure: null } : state;
    case "open_legal":
      return canOpenLegal(state.view) ? { ...state, view: "legal", legalReturn: state.view } : state;
    case "close_legal": {
      if (state.view !== "legal") return state;
      if (state.legalReturn === null) throw new Error("协议页不知道该回到哪里");
      return { ...state, view: state.legalReturn, legalReturn: null };
    }
    case "opening_launcher":
      return state.view === "done" || state.view === "installed" ? { ...state, opening: true } : state;
    case "crashed":
      return { ...state, view: "fatal", fatal: event.detail };
  }
}

/** 把一串事件依次过一遍：开发时直达某个视图，测试里摆状态。 */
export function replay(events: readonly SetupEvent[], from: SetupState = initialState): SetupState {
  return events.reduce(reduce, from);
}

/** 程序实际所在的目录：首装是计划里的目录，覆盖安装是探测到的目录。 */
export function installedDir(state: SetupState): string {
  const dir = state.plan?.dir ?? state.probe?.existing?.dir;
  if (dir === undefined || dir === null) throw new Error(`视图 ${state.view} 不知道程序装在哪里`);
  return dir;
}

export type FailureRecovery = "change_location" | "retry";

/** 写不进、盘满时重试没用，要换位置；但覆盖安装的位置是锁定的，换不了，只能重试。 */
export function failureRecovery(code: FailureCode, plan: InstallPlan): FailureRecovery {
  return plan.mode === "fresh" && (code === "dir_unwritable" || code === "disk_full") ? "change_location" : "retry";
}

/**
 * 这两类失败说明静默安装这条路走不通，原生向导是最后的退路。换通道的那次不给：原生向导不经这里的判定，
 * 它拦不拦往更早的版本装核实不了，后端也会拒绝只允许换通道的那次改用它。
 */
export function offersStandardInstaller(code: FailureCode, plan: InstallPlan): boolean {
  return plan.mode !== "switch" && (code === "payload_exit" || code === "verify_failed");
}

/**
 * 失败页要不要补一句怎么回到原来的通道：只在启动器带换通道开关拉起的那次。那时启动器已先把更新通道改成目标通道，
 * 装不上用户就停在它上面；交互的换通道失败时偏好没动，不用说。
 */
export function remindsChannelRevert(plan: InstallPlan, probe: Probe): boolean {
  return plan.mode === "switch" && unattendedMode(probe) === "switch";
}

export type DirNotice = { kind: "issue"; issue: DirIssue } | { kind: "resume" } | { kind: "nested" } | { kind: "not_empty" } | { kind: "ok" };

/** 选目录页按优先级只显示一条：阻断问题 > 有旧数据 > 有别的文件、另建了一层 > 有别的文件、会放在一起 > 正常。 */
export function dirNotice(check: DirCheck): DirNotice {
  if (check.issue !== null) return { kind: "issue", issue: check.issue };
  if (check.hasConfig) return { kind: "resume" };
  if (check.appended) return { kind: "nested" };
  if (check.notEmpty) return { kind: "not_empty" };
  return { kind: "ok" };
}

/**
 * 浏览选回的文件夹末段不是程序名时补一层：选 D:\Games 的人要的是 D:\Games\Petalfall，
 * 而不是把程序和数据撒进 D:\Games。Windows 路径不分大小写。
 */
export function withAppFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop();
  if (last !== undefined && last.toLowerCase() === APP_NAME_EN.toLowerCase()) return trimmed;
  return `${trimmed}\\${APP_NAME_EN}`;
}
