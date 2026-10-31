// 设置页、实例页与首次启动向导要用、页面与流程又不能直接调用的宿主能力：系统选择文件夹、选择文件与保存文件对话框、
// 其他游戏目录的登记与移除、打开启动器数据目录与日志目录。这里给出真实实现，由 App 经各自的 Provider 注入；
// 形状与页面、流程声明的接口一致，类型由 App 在注入处核对（外壳不引用 pages/ 与 flows/）。

import { open, save } from "@tauri-apps/plugin-dialog";
import { inTauri } from "../ipc/bridge";
import { addGameDirectory, removeGameDirectory } from "../ipc/config";
import { openFolder } from "../ipc/instances";

/** 浏览器预览里没有系统对话框：如实拒绝（由外层统一提示），不当作用户取消。 */
class NoNativeDialogError extends Error {
  constructor(what: "选择文件夹" | "选择文件" | "保存文件", hint: string) {
    super(`浏览器预览里没有系统的${what}对话框，${hint}`);
    this.name = "NoNativeDialogError";
  }
}

const TYPE_PATH_HINT = "请直接在输入框里填写路径";

/** 系统选择文件夹对话框，从 defaultPath 打开；用户取消为 null。 */
export async function pickDirectory(defaultPath: string): Promise<string | null> {
  if (!inTauri()) throw new NoNativeDialogError("选择文件夹", TYPE_PATH_HINT);
  return open({ directory: true, multiple: false, defaultPath });
}

export interface FileFilter {
  /** 对话框里文件类型下拉的名称（「整合包」）。 */
  name: string;
  /** 不带点的扩展名。 */
  extensions: readonly string[];
}

/** 系统选择文件对话框，只选一个文件；用户取消为 null。 */
export async function pickFile(options: { title: string; filter: FileFilter }): Promise<string | null> {
  if (!inTauri()) throw new NoNativeDialogError("选择文件", TYPE_PATH_HINT);
  return open({ title: options.title, multiple: false, directory: false, filters: [{ name: options.filter.name, extensions: [...options.filter.extensions] }] });
}

/**
 * 系统保存文件对话框：defaultPath 可以只是文件名（落在系统默认的文件夹里），filter 限定保存类型。
 * 选定返回完整路径，用户取消为 null；覆盖已有文件的确认由系统对话框自己问过。
 */
export async function pickSaveFile(options: { title: string; defaultPath: string; filter: FileFilter }): Promise<string | null> {
  if (!inTauri()) throw new NoNativeDialogError("保存文件", "导出要在桌面应用里进行");
  return save({ title: options.title, defaultPath: options.defaultPath, filters: [{ name: options.filter.name, extensions: [...options.filter.extensions] }] });
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

export interface LauncherFolderCommands {
  /** 在系统文件管理器里打开启动器数据目录。 */
  openDataDirectory(): Promise<void>;
  /** 在系统文件管理器里打开启动器自己的日志目录。 */
  openLauncherLogs(): Promise<void>;
}

// 这两个目标不属于任何实例，后端要求 id 传 null
export const launcherFolderCommands: LauncherFolderCommands = {
  openDataDirectory: () => openFolder("data_dir", null),
  openLauncherLogs: () => openFolder("launcher_logs", null),
};
