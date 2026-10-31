// 启动器自更新的几条后端命令，按状态机执行者要的形状接好。下载进度来自带同一 task_id 的 core-event，
// 下载结束（含失败与取消）即退订，晚到的进度事件不会再写进状态。

import { checkUpdate, downloadUpdate, installUpdate, setInstallOnExit } from "../../ipc/system";
import { cancelTask, onCoreEvent } from "../../ipc/tasks";
import type { UpdaterPort } from "./controller";

export const UPDATER_PORT: UpdaterPort = {
  check: () => checkUpdate(),
  download: async (taskId, onProgress) => {
    const unlisten = await onCoreEvent((event) => {
      if (event.kind === "download" && event.task_id === taskId) onProgress(event.bytes, event.total_bytes);
    });
    try {
      return await downloadUpdate(taskId);
    } finally {
      unlisten();
    }
  },
  cancel: async (taskId) => {
    // 返回值只说明任务是否还在跑：已经结束的下载不需要再取消，结果以下载命令自己的返回为准
    await cancelTask(taskId);
  },
  install: () => installUpdate(),
  setInstallOnExit: (enabled) => setInstallOnExit(enabled),
};
