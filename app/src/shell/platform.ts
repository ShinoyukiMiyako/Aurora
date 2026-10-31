// 设置页、首次启动向导与启动器更新要用、页面与流程又不能直接调用的宿主能力：系统选择文件夹对话框、
// 其他游戏目录的登记与移除、启动器自更新的几条命令。这里给出真实实现，由 App 经各自的 Provider 注入；
// 形状与页面、流程声明的接口一致，类型由 App 在注入处核对（外壳不引用 pages/ 与 flows/）。

import { open } from "@tauri-apps/plugin-dialog";
import { inTauri } from "../ipc/bridge";
import { addGameDirectory, removeGameDirectory } from "../ipc/config";
import { checkUpdate, downloadUpdate, installUpdate, setInstallOnExit, type UpdateDto } from "../ipc/system";
import { cancelTask, onCoreEvent } from "../ipc/tasks";

/** 浏览器预览里没有系统对话框：如实拒绝（由外层统一提示），不当作用户取消。 */
class NoNativeDialogError extends Error {
  constructor() {
    super("浏览器预览里没有系统的选择文件夹对话框，请直接在输入框里填写路径");
    this.name = "NoNativeDialogError";
  }
}

/** 系统选择文件夹对话框，从 defaultPath 打开；用户取消为 null。 */
export async function pickDirectory(defaultPath: string): Promise<string | null> {
  if (!inTauri()) throw new NoNativeDialogError();
  return open({ directory: true, multiple: false, defaultPath });
}

export interface GameDirectoryCommands {
  /** add_game_directory：同路径已登记时只改名字。 */
  addGameDirectory(name: string, path: string): Promise<void>;
  /** remove_game_directory：只删记录不动磁盘。 */
  removeGameDirectory(path: string): Promise<void>;
}

export const gameDirectoryCommands: GameDirectoryCommands = {
  addGameDirectory: (name, path) => addGameDirectory(name, path),
  removeGameDirectory: async (path) => {
    // 记录本来就不在时后端返回 false；调用方随后刷新目录列表，以后端为准
    await removeGameDirectory(path);
  },
};

export interface UpdaterCommands {
  check(): Promise<UpdateDto | null>;
  download(taskId: string, onProgress: (bytes: number, totalBytes: number | null) => void): Promise<UpdateDto>;
  cancel(taskId: string): Promise<void>;
  install(): Promise<void>;
  setInstallOnExit(enabled: boolean): Promise<void>;
}

/** 启动器自更新命令。下载进度来自带同一 task_id 的 core-event，下载结束（含失败与取消）即退订。 */
export const updaterCommands: UpdaterCommands = {
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
