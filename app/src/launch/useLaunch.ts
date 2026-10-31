// 一个实例的启动入口：视图 + 入口上的全部动作。胶囊、卡片底栏、侧栏右键菜单、命令面板都经它，
// 动作一律经外层统一错误处理执行，入口本身不写 try/catch。
//
// 「正在结束」是纯界面态：确认结束游戏或点了取消启动、IPC 还没返回的这段时间，由发起操作的入口持有，不进状态容器。
// 超时（10 s）由动作本身以错误结束，经统一错误处理弹「无法结束游戏进程」，入口回到原状态。

import { useCallback, useEffect, useState } from "react";
import { ACTION_ERROR, CONFIRM_COPY, type FailureCopy, type FailureFixKind } from "../copy/flows";
import { javaPinned, type InstanceSummary } from "../domain/adapt";
import { useLauncher } from "../state/launcher";
import { useInstanceSettings } from "../state/queries/instance";
import { getInstance } from "../state/selectors";
import { useLaunchHost } from "./host";
import { launchFailure, launchView, type LaunchView } from "./launchView";

export interface LaunchEntry {
  instance: InstanceSummary;
  view: LaunchView;
  /** 正在结束（界面态）：只在 loading / running 视图下有意义。 */
  stopping: boolean;
  /** failed 视图的文案与修复动作；其余视图为 null。 */
  failure: FailureCopy | null;
  /** 启动（就绪、已结束、失败、崩溃后再启动）；损坏时由状态容器转成「修复并启动」。 */
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
  const { state, actions } = useLauncher();
  const host = useLaunchHost();
  const inst = getInstance(state, instanceId);
  const view = launchView(state, inst);
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

  const launch = useCallback(() => {
    void host.run(() => actions.launch(instanceId), isBroken ? ACTION_ERROR.repair : ACTION_ERROR.launch(name));
  }, [actions, host, instanceId, isBroken, name]);

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

  return { instance: inst, view, stopping, failure, launch, cancel, stop, dismiss, openCrash, openLogs, fix };
}
