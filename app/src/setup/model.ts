// 引导程序的状态机：纯函数，不碰 bridge、不碰时间。异步的部分（探测、查进程、安装、轮询）都在 App.tsx，
// 结果作为事件送进来。判定「已安装到底是什么情况」全在 Rust 的 probe，这里只把结果映射到视图。
//
// 事件可能晚到：查进程的回包、进度事件都可能在视图已经变了之后才到，所以当前视图不接受的事件一律原样返回状态，
// 不当错误处理。这也是防重复点击的最后一道：第二次「安装」落在 installing 上什么都不会发生。

import { APP_NAME_EN } from "../lib/app-info";
import type { DirCheck, DirIssue, Existing, Failure, FailureCode, InstallMode, InstallPlan, Probe, Progress } from "./contract";

export type View = "boot" | "welcome" | "location" | "installed" | "blocked" | "installing" | "done" | "failed" | "legal" | "fatal";

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

export type SetupEvent =
  | { type: "probed"; probe: Probe }
  | { type: "open_location" }
  | { type: "leave_location" }
  | { type: "dir_changed"; dir: string }
  | { type: "use_default_dir" }
  | { type: "shortcut_changed"; value: boolean }
  | { type: "install_requested"; mode: "fresh"; running: boolean; check: DirCheck }
  | { type: "install_requested"; mode: "upgrade" | "repair"; running: boolean }
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

/** 现有安装决定能走哪种安装：newer 一种都不能走，降级保护只有这一道。 */
export function allowedModes(existing: Existing | null): readonly InstallMode[] {
  if (existing === null) return ["fresh"];
  switch (existing.kind) {
    case "upgrade":
      return ["upgrade"];
    case "same":
    case "broken":
      return ["repair"];
    case "newer":
      return [];
  }
}

function requireProbe(state: SetupState): Probe {
  if (state.probe === null) throw new Error(`视图 ${state.view} 需要探测结果，状态里没有`);
  return state.probe;
}

function startInstall(state: SetupState, running: boolean): SetupState {
  return running ? { ...state, view: "blocked" } : { ...state, view: "installing", run: state.run + 1, progress: null, failure: null };
}

function requestInstall(state: SetupState, event: Extract<SetupEvent, { type: "install_requested" }>): SetupState {
  if (state.view !== "welcome" && state.view !== "location" && state.view !== "installed" && state.view !== "failed") return state;
  const probe = requireProbe(state);
  if (!allowedModes(probe.existing).includes(event.mode)) return state;
  const origin = state.view === "failed" ? state.origin : state.view;

  if (event.mode === "fresh") {
    if (event.check.issue !== null) return { ...state, view: "location", dirCheck: event.check, origin };
    const plan: InstallPlan = { mode: "fresh", dir: event.check.normalized, desktopShortcut: state.desktopShortcut };
    return startInstall({ ...state, plan, origin, keptData: event.check.hasConfig }, event.running);
  }
  // 这两种模式没有快捷方式的选项，NSIS 却总会建一个：传 false 让 Rust 删掉本来没有的，用户删过的不会被装回来
  const plan: InstallPlan = { mode: event.mode, dir: null, desktopShortcut: false };
  return startInstall({ ...state, plan, origin, keptData: true }, event.running);
}

export function reduce(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case "probed": {
      if (state.view !== "boot") return state;
      const { existing } = event.probe;
      return { ...state, probe: event.probe, dir: existing?.dir ?? event.probe.defaultDir, view: existing === null ? "welcome" : "installed" };
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

/** 这两类失败说明静默安装这条路走不通，原生向导是最后的退路。 */
export function offersStandardInstaller(code: FailureCode): boolean {
  return code === "payload_exit" || code === "verify_failed";
}

export type DirNotice = { kind: "issue"; issue: DirIssue } | { kind: "resume" } | { kind: "not_empty" } | { kind: "ok" };

/** 选目录页按优先级只显示一条：阻断问题 > 有旧数据 > 有别的文件 > 正常。 */
export function dirNotice(check: DirCheck): DirNotice {
  if (check.issue !== null) return { kind: "issue", issue: check.issue };
  if (check.hasConfig) return { kind: "resume" };
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
