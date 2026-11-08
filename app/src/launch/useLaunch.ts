// 一个实例的启动入口：视图 + 入口上的全部动作。胶囊、卡片底栏、侧栏右键菜单、命令面板都经它，
// 动作一律经外层统一错误处理执行，入口本身不写 try/catch。
//
// 「正在结束」是纯界面态：确认结束游戏或点了取消启动、IPC 还没返回的这段时间，由发起操作的入口持有，不进状态容器。
// 超时（10 s）由动作本身以错误结束，经统一错误处理弹「无法结束游戏进程」，入口回到原状态。

import { useCallback, useEffect, useState } from "react";
import { ACTION_ERROR, CONFIRM_COPY, INSTANCE_IN_USE_COPY, LAUNCH_COPY, lockReason, type FailureCopy, type FailureFixKind } from "../copy/flows";
import { javaPinned, type InstanceSummary } from "../domain/adapt";
import { locksOf } from "../domain/instance-locks";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useInstanceSettings } from "../state/queries/instance";
import { reimportRoute } from "../state/route";
import { getInstance, savesBusy } from "../state/selectors";
import { useLaunchHost } from "./host";
import { launchFailure, launchView, launchViewEqual, type LaunchView } from "./launchView";

export interface LaunchEntry {
  instance: InstanceSummary;
  view: LaunchView;
  /** 正在结束（界面态）：只在 loading / running 视图下有意义。 */
  stopping: boolean;
  /** failed 视图的文案与修复动作；其余视图为 null。 */
  failure: FailureCopy | null;
  /**
   * 此刻不能启动的原因：存档正在备份、恢复或导出，或者别的实例正以它为基底，后端会以 instance_busy 拒绝。入口据此
   * 带原因禁用启动与重新启动，取消、结束、查看诊断不受影响；能启动为 null。
   */
  blocked: string | null;
  /**
   * 损坏实例此刻不能修复的原因：后端占着它或别的实例正以它为基底，补全排上也会被 instance_busy 拒绝。入口据此带原因禁用
   * 「修复并启动」；重新导入建的是新实例，不受影响。能修复或不是损坏视图为 null。
   */
  repairBlocked: string | null;
  /** 启动（就绪、已结束、失败、崩溃后再启动）；损坏时由状态容器转成「修复并启动」，整合包没导入完的去重新导入。 */
  launch(): void;
  /** 取消启动：加载阶段，不确认。 */
  cancel(): void;
  /** 结束游戏：运行中，先确认。 */
  stop(): void;
  /** 收起失败或崩溃的会话。 */
  dismiss(): void;
  openCrash(): void;
  openLogs(): void;
  /** 执行失败会话的修复动作。 */
  fix(kind: FailureFixKind): void;
}

export function useLaunch(instanceId: string): LaunchEntry {
  // 按片订阅：别的实例的下载进度、这一局的游戏日志都不让入口重渲染
  const actions = useLauncherActions();
  const host = useLaunchHost();
  const inst = useLauncherSelector((s) => getInstance(s, instanceId));
  const view = useLauncherSelector((s) => launchView(s, getInstance(s, instanceId)), launchViewEqual);
  const busySaves = useLauncherSelector((s) => savesBusy(s, getInstance(s, instanceId)));
  const [stopping, setStopping] = useState(false);

  // spawn_failed 的第二个按钮只在实例固定了 Java 时出现，要读实例设置；其余视图不发这个请求
  const needsSettings = view.kind === "failed" && view.code === "spawn_failed";
  const settings = useInstanceSettings(needsSettings ? instanceId : null);
  const settingsError = settings.status === "error" ? settings.error : null;
  useEffect(() => {
    if (settingsError === null) return;
    // 读不出设置时不提供第二个按钮；错误照常交给外层报告，不悄悄吞掉
    void host.run(() => Promise.reject(settingsError), ACTION_ERROR.readInstanceSettings);
  }, [host, settingsError]);
  const failure = view.kind === "failed" ? launchFailure(view, settings.status === "ready" && javaPinned(settings.data)) : null;

  const name = inst.name;
  const isBroken = view.kind === "broken";
  const reimport = view.kind === "broken" && view.reimport;

  const launch = useCallback(() => {
    if (reimport) {
      host.go(reimportRoute(inst));
      return;
    }
    void host.run(() => actions.launch(instanceId), isBroken ? ACTION_ERROR.repair : ACTION_ERROR.launch(name));
  }, [actions, host, inst, instanceId, isBroken, name, reimport]);

  const endSession = useCallback(async () => {
    setStopping(true);
    await host.run(() => actions.stop(), ACTION_ERROR.stop);
    setStopping(false);
  }, [actions, host]);

  const cancel = useCallback(() => {
    void endSession();
  }, [endSession]);

  const stop = useCallback(() => {
    void (async () => {
      const ok = await host.confirm({ ...CONFIRM_COPY.stopGame(name), tone: "danger" });
      if (ok) await endSession();
    })();
  }, [endSession, host, name]);

  const dismiss = useCallback(() => actions.dismissSession(), [actions]);
  const openCrash = useCallback(() => host.go({ page: "instance", id: instanceId, tab: "crash" }), [host, instanceId]);
  const openLogs = useCallback(() => host.go({ page: "instance", id: instanceId, tab: "logs" }), [host, instanceId]);

  const fix = useCallback(
    (kind: FailureFixKind) => {
      void host.run(async () => {
        const target = actions.failureFix(kind);
        if ("to" in target) {
          host.go(target.to);
          return;
        }
        await host.run(target.run, target.errorTitle);
      }, ACTION_ERROR.launch(name));
    },
    [actions, host, name],
  );

  // 启动入口只在这个实例没有活动会话时才问这两项，损坏视图同样，会话这一项恒为 false
  const locks = locksOf(inst, false);
  const blocked = busySaves ? LAUNCH_COPY.savesBusy : locks.launch === null ? null : locks.launch === "moving" ? LAUNCH_COPY.moving : INSTANCE_IN_USE_COPY.launch(locks.launch.usedBy);
  const repairReason = isBroken && !reimport ? lockReason(locks.repair, "repair") : undefined;
  const repairBlocked = repairReason === undefined ? null : repairReason;
  return { instance: inst, view, stopping, failure, blocked, repairBlocked, launch, cancel, stop, dismiss, openCrash, openLogs, fix };
}
