// 启动视图：一个实例此刻该怎么呈现启动入口。胶囊、状态岛、侧栏头像、卡片底栏都只读这一个判定，不另造状态机。
// 同一实例既有会话又有自身状态（安装中、损坏）时会话优先：正在跑的游戏比「已损坏」更值得说。

import { failureCopy, LAUNCH_STAGES, phaseLabel, SESSION_COPY, crashCategoryLabel, type FailureCopy } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import type { FailureCode, StopReason, Task } from "../domain/types";
import { busyInstanceId, instanceTask, queuePosition } from "../state/selectors";
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
      /** 实例上挂着的前端任务；后端报告在安装、前端没有对应任务（另一次运行留下的标记）时为 null。 */
      task: Task | null;
      /** 排队中的名次（从 1 起）；进行中或没有任务为 null。 */
      queuePosition: number | null;
    }
  | { kind: "broken"; reason: string };

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
    const task = instanceTask(state, inst.id);
    return { kind: "installing", task, queuePosition: task === null ? null : queuePosition(state, task.id) };
  }
  if (inst.status === "broken") {
    if (inst.brokenReason === null) throw new Error(`实例 ${inst.id} 损坏但没有原因`);
    return { kind: "broken", reason: inst.brokenReason };
  }
  const busy = busyInstanceId(state);
  return { kind: "ready", busyElsewhere: busy !== null && busy !== inst.id };
}

/** 失败会话的文案；javaPinned 只影响 spawn_failed 的第二个按钮（实例设置固定了 Java 时才出现）。 */
export function launchFailure(view: Extract<LaunchView, { kind: "failed" }>, javaPinned: boolean): FailureCopy {
  return failureCopy(view.code, view.params, { accountName: view.session.accountName, javaPinned });
}

/**
 * 会话的第二行文案（胶囊副标题与状态岛详情共用）。崩溃报告还没读出来时为 null（不画副行）。
 * now 由调用方按秒刷新，「已运行 mm:ss」才会走。
 */
export function sessionDetail(session: SessionState, now: number): string | null {
  switch (session.phase) {
    case "preparing":
    case "launching":
      return stageLabel(session.stageIndex);
    case "downloading": {
      const d = session.download;
      if (d === null || d.total === null) return SESSION_COPY.countingFiles;
      return SESSION_COPY.downloadProgress(d.done, d.total, d.speedBps);
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
      return failureCopy(session.failure.code, session.failure.params, { accountName: session.accountName, javaPinned: false }).title;
    }
    case "crashed": {
      const crash = session.crash;
      if (crash === null || crash.status === "pending") return null;
      if (crash.status === "unavailable" || crash.category === null) return SESSION_COPY.noClue;
      return SESSION_COPY.crashClue(crashCategoryLabel(crash.category));
    }
  }
}

export function stageLabel(stageIndex: number): string {
  const label = LAUNCH_STAGES[stageIndex];
  if (label === undefined) throw new Error(`阶段下标 ${stageIndex} 超出八阶段表`);
  return label;
}

/** 会话的 phase 文案（状态岛、读屏播报）。 */
export function sessionPhaseLabel(session: SessionState): string {
  return phaseLabel(session.phase, session.stopReason);
}
