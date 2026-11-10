// 启动器自更新的状态机：纯函数，不碰 IPC 与 React。
//
// 两路输入：后端的更新信息（updater_info：能力、通道、本次会话最近一次检查到的版本、已下载的版本、是否退出时安装）
// 与界面发起的动作（检查、下载、安装、改更新通道）。后端信息只能说明「有没有、下没下好」，说明不了「刚检查过、已是最新」
// 「正在下载」这些只存在于本次会话里的事，所以两路合并：瞬时阶段（检查中、下载中、安装中）不被后端信息覆盖，
// 「已是最新」「检查失败」这类会话内结论在后端没有更新可报时保留。

import type { UpdateChannel } from "../../ipc/system";
import type { NetworkFailure } from "../errors";
import type { UpdaterInfoDto } from "../queries/catalog";

/** 一个可安装的版本。字段与后端 UpdateDto 同形。 */
export type UpdateInfo = NonNullable<UpdaterInfoDto["available"]>;

export type UnsupportedReason = UpdaterInfoDto["unsupported_reason"];

/** 更新信息里与通道有关的几项，字段名照搬：包的通道、生效的偏好、两者的关系、各通道最近一次的结果、本次会话被拒的版本。 */
export type UpdaterChannels = Pick<UpdaterInfoDto, "package_channel" | "preference" | "relation" | "channel_heads" | "refused">;

/** 下载并验过签之后仍不能装的原因。data_too_new：这一版读不了这台电脑上的数据。 */
export type DownloadRefusal = "data_too_new";

/** 正在用的下载源：index 从 0 计，count 是这次候选源的总数，name 是源的短名（只供日志，界面不显示）。 */
export interface DownloadSource {
  index: number;
  count: number;
  name: string;
}

export type UpdaterPhase =
  /** 当前环境没有更新能力（调试构建、没配公钥）：所有按钮禁用。 */
  | { kind: "unsupported"; reason: UnsupportedReason }
  /** 本次会话还没检查过。 */
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date"; checkedAt: number }
  /**
   * message 是后端原文；network 是后端标明的网络层失败种类，其余失败为 null；staleChannel 是给出的版本全都旧于本机记录的
   * 那个通道（update_source_stale），其余失败为 null。
   */
  | { kind: "check_failed"; message: string; network: NetworkFailure | null; staleChannel: UpdateChannel | null }
  | { kind: "available"; update: UpdateInfo }
  /** source 是后端报的当前下载源；第一条换源事件到达之前为 null。 */
  | { kind: "downloading"; update: UpdateInfo; taskId: string; bytes: number; totalBytes: number | null; source: DownloadSource | null }
  /**
   * reason 是后端原文；network 同 check_failed；sourcesTried 是试过的下载源个数，后端没列出逐源失败时按 1 个算。
   * refusal 不为 null 时下载与验签都成了、只是 update 这一版不能装：再下必然同样被拒，所以不能从这里重试；
   * 后端随后不再报这一版，这个结论仍留到别的结果出现为止。
   */
  | { kind: "download_failed"; update: UpdateInfo; reason: string; signature: boolean; network: NetworkFailure | null; sourcesTried: number; refusal: DownloadRefusal | null }
  /** 已下载并通过签名校验，等用户决定何时安装。 */
  | { kind: "ready"; update: UpdateInfo }
  | { kind: "install_on_exit"; update: UpdateInfo }
  | { kind: "installing"; update: UpdateInfo };

export type PhaseKind = UpdaterPhase["kind"];

export interface UpdaterState {
  /** 后端信息到达前为 null。 */
  currentVersion: string | null;
  /** 后端信息到达前为 null；之后每次信息到达整份换成新的。 */
  channels: UpdaterChannels | null;
  phase: UpdaterPhase;
  /** 用户打开过更新面板的版本：提示点只为没看过的新版本亮。 */
  seenVersion: string | null;
  /**
   * 改了更新通道之后欠着的那次检查：每次改成功换成那次改动的代次（只增不减），外壳据它的变化重新计时，
   * 停够、联网、能检查时发起；任何一次检查真正开始后回到 null。
   */
  channelCheckDue: number | null;
}

export type UpdaterEvent =
  | { type: "info"; info: UpdaterInfoDto }
  | { type: "check_start" }
  | { type: "check_done"; update: UpdateInfo | null; at: number }
  | { type: "check_failed"; message: string; network: NetworkFailure | null; staleChannel: UpdateChannel | null }
  /** 检查期间改了更新通道：结果是按旧偏好得出的，不落进状态。 */
  | { type: "check_superseded" }
  /** 更新通道写成功了：info 是写完之后的更新信息，generation 是这次改动的代次。 */
  | { type: "preference_changed"; info: UpdaterInfoDto; generation: number }
  | { type: "download_start"; taskId: string }
  | { type: "download_progress"; taskId: string; bytes: number; totalBytes: number | null }
  | ({ type: "download_source"; taskId: string } & DownloadSource)
  | { type: "download_done"; taskId: string; update: UpdateInfo }
  | { type: "download_failed"; taskId: string; reason: string; signature: boolean; network: NetworkFailure | null; sourcesTried: number; refusal: DownloadRefusal | null }
  | { type: "download_cancelled"; taskId: string }
  | { type: "install_on_exit"; enabled: boolean }
  | { type: "install_start" }
  | { type: "install_failed" }
  /** 安装命令返回了（没有随进程退出）：后端已切到新版本，按后端信息重新来过。 */
  | { type: "install_done" }
  | { type: "panel_seen"; version: string };

export const INITIAL_UPDATER_STATE: UpdaterState = { currentVersion: null, channels: null, phase: { kind: "idle" }, seenVersion: null, channelCheckDue: null };

/** 阶段里带着的版本；没有版本的阶段为 null。 */
export function phaseUpdate(phase: UpdaterPhase): UpdateInfo | null {
  return "update" in phase ? phase.update : null;
}

/**
 * 已下载的那一版。通道只看 downloaded_channel：检查结果恰好是同一版时也只借它的更新说明与发布时间；
 * 检查结果已被新一轮检查替换时说明与时间为 null。
 */
function downloadedUpdate(info: UpdaterInfoDto, version: string): UpdateInfo {
  const channel = info.downloaded_channel;
  if (channel === null) throw new Error(`后端报了已下载的 ${version}，却没报它所属的通道`);
  // 这里只认普通更新：别的用意的包不能照普通更新那样进「退出时安装」
  if (info.downloaded_intent !== "update") throw new Error(`后端报了已下载的 ${version}，用意却是 ${String(info.downloaded_intent)}，不是普通更新`);
  const listed = info.available !== null && info.available.version === version ? info.available : null;
  return { version, current_version: info.current_version, notes: listed === null ? null : listed.notes, date: listed === null ? null : listed.date, channel };
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
  // 后端没有可报的更新：会话内「已是最新 / 检查失败」的结论仍然成立；被拒装同样是会话内结论，后端拒了之后本来就不再报那一版；
  // 其余带版本的阶段说明那一版已经不在了
  if (prev.kind === "up_to_date" || prev.kind === "check_failed" || prev.kind === "idle") return prev;
  if (prev.kind === "download_failed" && prev.refusal !== null) return prev;
  return { kind: "idle" };
}

function withInfo(state: UpdaterState, info: UpdaterInfoDto, phase: UpdaterPhase): UpdaterState {
  const channels: UpdaterChannels = {
    package_channel: info.package_channel,
    preference: info.preference,
    relation: info.relation,
    channel_heads: info.channel_heads,
    refused: info.refused,
  };
  return { ...state, currentVersion: info.current_version, channels, phase };
}

/** 改了更新通道之后回到 idle 的阶段：它们都是按旧偏好得出的结论，或是后端已随之丢掉的包。 */
const RESET_BY_PREFERENCE: ReadonlySet<PhaseKind> = new Set<PhaseKind>(["idle", "up_to_date", "check_failed", "available", "download_failed", "ready", "install_on_exit"]);

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
      return withInfo(state, event.info, fromInfo(phase, event.info));
    case "preference_changed": {
      const synced = fromInfo(phase, event.info);
      // 检查中由执行者作废那次结果，下载在写偏好之前已经取消，安装中后端不让改：这三种阶段各自收尾
      const next: UpdaterPhase = RESET_BY_PREFERENCE.has(synced.kind) ? { kind: "idle" } : synced;
      return { ...withInfo(state, event.info, next), channelCheckDue: event.generation };
    }
    case "check_start":
      // 已下载或正在下载时再检查，后端可能因版本变化丢弃下好的包；那几个阶段界面不给检查入口，这里同样拒绝
      if (!CHECKABLE.has(phase.kind)) return state;
      return { ...state, phase: { kind: "checking" }, channelCheckDue: null };
    case "check_done":
      if (phase.kind !== "checking") return state;
      return to(event.update === null ? { kind: "up_to_date", checkedAt: event.at } : { kind: "available", update: event.update });
    case "check_failed":
      if (phase.kind !== "checking") return state;
      return to({ kind: "check_failed", message: event.message, network: event.network, staleChannel: event.staleChannel });
    case "check_superseded":
      if (phase.kind !== "checking") return state;
      return to({ kind: "idle" });
    case "download_start": {
      const update = phaseUpdate(phase);
      if (update === null || (phase.kind !== "available" && phase.kind !== "download_failed")) return state;
      if (phase.kind === "download_failed" && phase.refusal !== null) return state;
      return to({ kind: "downloading", update, taskId: event.taskId, bytes: 0, totalBytes: null, source: null });
    }
    case "download_progress":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ ...phase, bytes: event.bytes, totalBytes: event.totalBytes });
    case "download_source":
      if (!sameTask(phase, event.taskId)) return state;
      // 换源后从头下：上一个源下到的字节作废，总量等新源的第一条进度
      return to({ ...phase, source: { index: event.index, count: event.count, name: event.name }, bytes: 0, totalBytes: null });
    case "download_done":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ kind: "ready", update: event.update });
    case "download_failed":
      if (!sameTask(phase, event.taskId)) return state;
      return to({ kind: "download_failed", update: phase.update, reason: event.reason, signature: event.signature, network: event.network, sourcesTried: event.sourcesTried, refusal: event.refusal });
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
