// 启动器自更新的几条后端命令，按状态机执行者要的形状接好。下载进度与换源来自带同一 task_id 的 core-event，
// 下载结束（含失败与取消）即退订，晚到的进度与换源事件不会再写进状态。

import { checkUpdate, downloadUpdate, installUpdate, setInstallOnExit, setUpdateChannel } from "../../ipc/system";
import { cancelTask, onCoreEvent } from "../../ipc/tasks";
import type { UpdaterPort } from "./controller";

export const UPDATER_PORT: UpdaterPort = {
  check: () => checkUpdate(),
  download: async (taskId, onProgress, onSource) => {
    const unlisten = await onCoreEvent((event) => {
      if (event.task_id !== taskId) return;
      if (event.kind === "download") onProgress(event.bytes, event.total_bytes);
      else if (event.kind === "source") onSource({ index: event.index, count: event.count, name: event.name });
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
  setChannel: (channel) => setUpdateChannel(channel),
};
