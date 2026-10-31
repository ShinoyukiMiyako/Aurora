// 「重启并安装」：游戏会话进行中不允许（入口已禁用）；有活动下载任务时先确认会中断它们；
// 安装会关闭启动器，动手前把下载任务记录写盘，重启后能看到被中断的任务并重试。

import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncher } from "../../../state/launcher";
import { activeTasks } from "../../../state/selectors";
import { UPDATE_COPY } from "../copy";
import { useUpdater } from "./useUpdater";

export function useInstallUpdate(): () => Promise<void> {
  const { state, actions } = useLauncher();
  const { confirm } = useShell();
  const run = useRunner();
  const updater = useUpdater();
  const pending = activeTasks(state).length;
  return async () => {
    if (pending > 0) {
      const ok = await confirm({
        title: UPDATE_COPY.tasksConfirmTitle,
        body: UPDATE_COPY.tasksConfirmBody(pending),
        confirmLabel: UPDATE_COPY.tasksConfirm,
        tone: "primary",
      });
      if (!ok) return;
    }
    await run(async () => {
      await actions.flushTaskJournal();
      await updater.install();
    }, UPDATE_COPY.installFailed);
  };
}
