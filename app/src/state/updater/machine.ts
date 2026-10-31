// 启动器自更新的状态机：纯函数，不碰 IPC 与 React。
//
// 两路输入：后端的更新信息（updater_info：能力、本次会话最近一次检查到的版本、已下载的版本、是否退出时安装）
// 与界面发起的动作（检查、下载、安装）。后端信息只能说明「有没有、下没下好」，说明不了「刚检查过、已是最新」
// 「正在下载」这些只存在于本次会话里的事，所以两路合并：瞬时阶段（检查中、下载中、安装中）不被后端信息覆盖，
// 「已是最新」「检查失败」这类会话内结论在后端没有更新可报时保留。

import type { UpdaterInfoDto } from "../queries/catalog";

/** 一个可安装的版本。字段与后端 UpdateDto 同形。 */
export type UpdateInfo = NonNullable<UpdaterInfoDto["available"]>;

export type UnsupportedReason = UpdaterInfoDto["unsupported_reason"];

export type UpdaterPhase =
  /** 当前环境没有更新能力（调试构建、没配公钥）：所有按钮禁用。 */
  | { kind: "unsupported"; reason: UnsupportedReason }
  /** 本次会话还没检查过。 */
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date"; checkedAt: number }
  | { kind: "check_failed"; message: string }
  | { kind: "available"; update: UpdateInfo }
  | { kind: "downloading"; update: UpdateInfo; taskId: string; bytes: number; totalBytes: number | null }
  | { kind: "download_failed"; update: UpdateInfo; reason: string; signature: boolean }
  /** 已下载并通过签名校验，等用户决定何时安装。 */
  | { kind: "ready"; update: UpdateInfo }
  | { kind: "install_on_exit"; update: UpdateInfo }
  | { kind: "installing"; update: UpdateInfo };

export type PhaseKind = UpdaterPhase["kind"];

export interface UpdaterState {
  /** 后端信息到达前为 null。 */
  currentVersion: string | null;
  phase: UpdaterPhase;
  /** 用户打开过更新面板的版本：提示点只为没看过的新版本亮。 */
  seenVersion: string | null;
}

export type UpdaterEvent =
  | { type: "info"; info: UpdaterInfoDto }
  | { type: "check_start" }
  | { type: "check_done"; update: UpdateInfo | null; at: number }
  | { type: "check_failed"; message: string }
  | { type: "download_start"; taskId: string }
  | { type: "download_progress"; taskId: string; bytes: number; totalBytes: number | null }
  | { type: "download_done"; taskId: string; update: UpdateInfo }
  | { type: "download_failed"; taskId: string; reason: string; signature: boolean }
  | { type: "download_cancelled"; taskId: string }
  | { type: "install_on_exit"; enabled: boolean }
  | { type: "install_start" }
  | { type: "install_failed" }
  /** 安装命令返回了（没有随进程退出）：后端已切到新版本，按后端信息重新来过。 */
  | { type: "install_done" }
  | { type: "panel_seen"; version: string };

export const INITIAL_UPDATER_STATE: UpdaterState = { currentVersion: null, phase: { kind: "idle" }, seenVersion: null };

/** 阶段里带着的版本；没有版本的阶段为 null。 */
export function phaseUpdate(phase: UpdaterPhase): UpdateInfo | null {
  return "update" in phase ? phase.update : null;
}

/** 后端只报了已下载的版本号、没有这一版的更新说明时（例如检查结果已被新一轮检查替换），按版本号补出一个。 */
function downloadedUpdate(info: UpdaterInfoDto, version: string): UpdateInfo {
  if (info.available !== null && info.available.version === version) return info.available;
  return { version, current_version: info.current_version, notes: null, date: null };
}

function fromInfo(prev: UpdaterPhase, info: UpdaterInfoDto): UpdaterPhase {
  if (!info.supported) return { kind: "unsupported", reason: info.unsupported_reason };
  // 界面发起、还没结束的动作以界面这一侧为准；后端信息在动作结束后会再同步一次
  if (prev.kind === "checking" || prev.kind === "downloading" || prev.kind === "installing") return prev;
  if (info.downloaded_version !== null) {
    const update = downloadedUpdate(info, info.downloaded_version);
    return info.install_on_exit ? { kind: "install_on_exit", update } : { kind: "ready", update };
  }
  if (info.available !== null) {
    const update = info.available;
    if (prev.kind === "download_failed" && prev.update.version === update.version) return { ...prev, update };
    return { kind: "available", update };
  }
  // 后端没有可报的更新：会话内「已是最新 / 检查失败」的结论仍然成立；带版本的阶段说明那一版已经不在了
  if (prev.kind === "up_to_date" || prev.kind === "check_failed" || prev.kind === "idle") return prev;
  return { kind: "idle" };
}

const CHECKABLE: ReadonlySet<PhaseKind> = new Set<PhaseKind>(["idle", "up_to_date", "check_failed", "available", "download_failed"]);

/** 现在能不能发起检查。 */
export function canCheck(phase: UpdaterPhase): boolean {
  return CHECKABLE.has(phase.kind);
}

function sameTask(phase: UpdaterPhase, taskId: string): phase is Extract<UpdaterPhase, { kind: "downloading" }> {
  return phase.kind === "downloading" && phase.taskId === taskId;
}

/** 事件与当前阶段不相符（例如旧下载晚到的进度）时原样返回，界面不被过期事件改动。 */
export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  const { phase } = state;
  const to = (next: UpdaterPhase): UpdaterState => ({ ...state, phase: next });
  switch (event.type) {
    case "info":
      return { ...state, currentVersion: event.info.current_version, phase: fromInfo(phase, event.info) };
    case "check_start":
      // 已下载或正在下载时再检查，后端可能因版本变化丢弃下好的包；那几个阶段界面不给检查入口，这里同样拒绝
      if (!CHECKABLE.has(phase.kind)) return state;
      return to({ kind: "checking" });
    case "check_done":
      if (phase.kind !== "checking") return state;
      return to(event.update === null ? { kind: "up_to_date", checkedAt: event.at } : { kind: "available", update: event.update });
    case "check_failed":
      if (phase.kind !== "checking") return state;
      return to({ kind: "check_failed", message: event.message });
    case "download_start": {
      const update = phaseUpdate(phase);
      if (update === null || (phase.kind !== "available" && phase.kind !== "download_failed")) return state;
      return to({ kind: "downloading", update, taskId: event.taskId, bytes: 0, totalBytes: null });
    }
    case "download_progress":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ ...phase, bytes: event.bytes, totalBytes: event.totalBytes });
    case "download_done":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ kind: "ready", update: event.update });
    case "download_failed":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ kind: "download_failed", update: phase.update, reason: event.reason, signature: event.signature });
    case "download_cancelled":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ kind: "available", update: phase.update });
    case "install_on_exit":
      if (event.enabled && phase.kind === "ready") return to({ kind: "install_on_exit", update: phase.update });
      if (!event.enabled && phase.kind === "install_on_exit") return to({ kind: "ready", update: phase.update });
      return state;
    case "install_start":
      if (phase.kind !== "ready" && phase.kind !== "install_on_exit") return state;
      return to({ kind: "installing", update: phase.update });
    case "install_failed":
      // 安装没能拉起时包仍在磁盘上，回到「已下载」让用户可以再试或改为退出时安装
      if (phase.kind !== "installing") return state;
      return to({ kind: "ready", update: phase.update });
    case "install_done":
      if (phase.kind !== "installing") return state;
      return to({ kind: "idle" });
    case "panel_seen":
      return { ...state, seenVersion: event.version };
  }
}

/** 有没有一个可以打开更新面板来看的版本。 */
export function hasPanel(phase: UpdaterPhase): boolean {
  return phaseUpdate(phase) !== null;
}

/**
 * 提示点：有没看过的新版本（被跳过的不算），或已下好、等安装。安装前一直保留，提醒用户还有一步没做。
 */
export function showsUpdateDot(state: UpdaterState, skippedVersion: string | null): boolean {
  const { phase } = state;
  if (phase.kind === "ready" || phase.kind === "install_on_exit" || phase.kind === "installing") return true;
  const update = phaseUpdate(phase);
  if (update === null) return false;
  return update.version !== skippedVersion && update.version !== state.seenVersion;
}

/** 下载进度（0 到 1）；总量未知为 null。 */
export function downloadFraction(bytes: number, totalBytes: number | null): number | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, bytes / totalBytes));
}
