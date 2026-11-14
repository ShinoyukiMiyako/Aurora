// 启动视图：一个实例此刻该怎么呈现启动入口。胶囊、状态岛、侧栏头像、卡片底栏都只读这一个判定，不另造状态机。
// 同一实例既有会话又有自身状态（安装中、损坏）时会话优先：正在跑的游戏比「已损坏」更值得说。

import type { IconName } from "../art/Icon";
import { failureCopy, LAUNCH_COPY, LAUNCH_STAGES, MODPACK_REIMPORT_COPY, phaseLabel, SESSION_COPY, crashClueLine, type FailureCopy } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { needsReimport } from "../domain/rules";
import type { FailureCode, StopReason, Task } from "../domain/types";
import { busyInstanceId, installTask, queuePosition } from "../state/selectors";
import { isLoadingPhase, sessionPlayedMinutes, type SessionState } from "../state/session";
import type { LauncherState } from "../state/store";

export type LoadingPhase = "preparing" | "downloading" | "launching";

export type LaunchView =
  | { kind: "ready"; /** 另一实例占着游戏进程：入口照常可点，点了走替换确认。 */ busyElsewhere: boolean }
  | { kind: "loading"; session: SessionState; phase: LoadingPhase }
  | { kind: "running"; session: SessionState }
  | { kind: "stopped"; session: SessionState; reason: StopReason }
  | { kind: "failed"; session: SessionState; code: FailureCode; params: Readonly<Record<string, string | number>> }
  | { kind: "crashed"; session: SessionState }
  | {
      kind: "installing";
      /**
       * 实例上挂着的前端任务（见 selectors 的 installTask）：任务完成后、落地重扫回来之前是那个已完成的任务，按满格画；
       * 后端报告在安装、前端没有对应任务（另一次运行留下的标记）时为 null。
       */
      task: Task | null;
      /** 排队中的名次（从 1 起）；进行中、已完成或没有任务为 null。 */
      queuePosition: number | null;
    }
  | {
      kind: "broken";
      reason: string;
      /** 整合包没导入完：补全补不回整合包里的 Mod 与配置，入口改为去重新导入，而不是修复并启动。 */
      reimport: boolean;
    };

export type LaunchViewKind = LaunchView["kind"];

export function launchView(state: LauncherState, inst: InstanceSummary): LaunchView {
  const s = state.session;
  if (s !== null && s.instanceId === inst.id) {
    if (isLoadingPhase(s.phase)) return { kind: "loading", session: s, phase: s.phase };
    switch (s.phase) {
      case "running":
        return { kind: "running", session: s };
      case "stopped":
        if (s.stopReason === null) throw new Error("stopped 会话缺少结束原因");
        return { kind: "stopped", session: s, reason: s.stopReason };
      case "failed":
        if (s.failure === null) throw new Error("failed 会话缺少失败码");
        return { kind: "failed", session: s, code: s.failure.code, params: s.failure.params };
      case "crashed":
        return { kind: "crashed", session: s };
    }
  }
  if (inst.status === "installing") {
    const task = installTask(state, inst.id);
    return { kind: "installing", task, queuePosition: task === null ? null : queuePosition(state, task.id) };
  }
  if (inst.status === "broken") {
    if (inst.brokenReason === null) throw new Error(`实例 ${inst.id} 损坏但没有原因`);
    return { kind: "broken", reason: inst.brokenReason, reimport: needsReimport(inst) };
  }
  const busy = busyInstanceId(state);
  return { kind: "ready", busyElsewhere: busy !== null && busy !== inst.id };
}

/** 会话除日志以外的字段都相同。入口只读阶段、进度、时刻与结局，不读日志；日志每 100 ms 一批，不该让入口跟着重渲染。 */
function sameSessionExceptLogs(a: SessionState, b: SessionState): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof SessionState)[]) {
    if (key !== "logs" && !Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** 两个启动视图画出来一样：按片订阅启动视图时的相等比较。 */
export function launchViewEqual(a: LaunchView, b: LaunchView): boolean {
  switch (a.kind) {
    case "ready":
      return b.kind === "ready" && a.busyElsewhere === b.busyElsewhere;
    case "loading":
      return b.kind === "loading" && a.phase === b.phase && sameSessionExceptLogs(a.session, b.session);
    case "running":
    case "crashed":
      return b.kind === a.kind && sameSessionExceptLogs(a.session, b.session);
    case "stopped":
      return b.kind === "stopped" && a.reason === b.reason && sameSessionExceptLogs(a.session, b.session);
    case "failed":
      return b.kind === "failed" && a.code === b.code && a.params === b.params && sameSessionExceptLogs(a.session, b.session);
    case "installing":
      return b.kind === "installing" && a.task === b.task && a.queuePosition === b.queuePosition;
    case "broken":
      return b.kind === "broken" && a.reason === b.reason && a.reimport === b.reimport;
  }
}

/** 损坏实例入口上的那一个动作（胶囊、卡片、侧栏菜单、命令面板共用）：修复并启动，或者去重新导入整合包。 */
export function brokenAction(view: Extract<LaunchView, { kind: "broken" }>): { label: string; icon: IconName } {
  return view.reimport ? { label: MODPACK_REIMPORT_COPY.menuReimport, icon: "modpack" } : { label: LAUNCH_COPY.repairAndLaunch, icon: "wrench" };
}

/** 失败会话的文案；javaPinned 只影响 spawn_failed 的第二个按钮（实例设置固定了 Java 时才出现）。 */
export function launchFailure(view: Extract<LaunchView, { kind: "failed" }>, javaPinned: boolean): FailureCopy {
  return failureCopy(view.code, view.params, { accountName: view.session.accountName, accountKind: view.session.accountKind, javaPinned });
}

/**
 * 会话的第二行文案（胶囊副标题与状态岛详情共用）。崩溃报告还没读出来时为 null（不画副行）。
 * now 由调用方按秒刷新，「已运行 mm:ss」才会走。
 * shownSpeed：下载阶段写出来的速度。这里是纯函数，平滑与换字节奏归渲染它的组件：传 lib/progress-display 的
 * useDisplaySpeed 给出的值（约 1 秒平均、每秒最多换两次字）；不传时写会话里的原始速度，每 100 ms 跳一次。
 */
export function sessionDetail(session: SessionState, now: number, shownSpeed?: number): string | null {
  switch (session.phase) {
    case "preparing":
    case "launching":
      return stageLabel(session.stageIndex);
    case "downloading": {
      const d = session.download;
      if (d === null || d.total === null) return SESSION_COPY.countingFiles;
      return SESSION_COPY.downloadProgress(d.done, d.total, shownSpeed === undefined ? d.speedBps : shownSpeed);
    }
    case "running":
      if (session.runningSince === null) throw new Error("running 会话缺少运行起点");
      return SESSION_COPY.running(now - session.runningSince);
    case "stopped": {
      if (session.stopReason === "cancelled") return SESSION_COPY.cancelledDetail;
      const minutes = sessionPlayedMinutes(session, now);
      if (minutes === null) throw new Error("游戏结束的会话缺少运行起点");
      return SESSION_COPY.played(minutes);
    }
    case "failed": {
      if (session.failure === null) throw new Error("failed 会话缺少失败码");
      // 标题与 javaPinned 无关
      return failureCopy(session.failure.code, session.failure.params, { accountName: session.accountName, accountKind: session.accountKind, javaPinned: false }).title;
    }
    case "crashed": {
      const crash = session.crash;
      if (crash === null || crash.status === "pending") return null;
      if (crash.status === "unavailable" || crash.category === null) return SESSION_COPY.noClue;
      return crashClueLine(crash.category);
    }
  }
}

export function stageLabel(stageIndex: number): string {
  const label = LAUNCH_STAGES[stageIndex];
  if (label === undefined) throw new Error(`阶段下标 ${stageIndex} 超出九阶段表`);
  return label;
}

/** 会话的 phase 文案（状态岛、读屏播报）。 */
export function sessionPhaseLabel(session: SessionState): string {
  return phaseLabel(session.phase, session.stopReason);
}
