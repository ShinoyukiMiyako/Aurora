// 设置页要用、状态层还没有提供调用入口的几项能力：系统选择文件夹对话框、登记与移除其他游戏目录、
// 打开数据目录与启动器日志目录。页面不能直接调用后端命令与 Tauri 插件，接入之前一律以明确的错误拒绝，
// 经外层统一提示出来，不假装成功。

import { createContext, useContext } from "react";

export interface SettingsCommands {
  /** 系统选择文件夹对话框；用户取消为 null。 */
  pickDirectory(defaultPath: string): Promise<string | null>;
  /** add_game_directory。 */
  addGameDirectory(name: string, path: string): Promise<void>;
  /** remove_game_directory：只删记录，不动磁盘。 */
  removeGameDirectory(path: string): Promise<void>;
  /** 在系统文件管理器里打开启动器数据目录。 */
  openDataDirectory(): Promise<void>;
  /** 在系统文件管理器里打开启动器自己的日志目录。 */
  openLauncherLogs(): Promise<void>;
}

function unavailable(what: string): Promise<never> {
  return Promise.reject(new Error(`状态层还没有提供「${what}」的调用入口`));
}

export const SETTINGS_COMMANDS: SettingsCommands = {
  pickDirectory: () => unavailable("选择文件夹"),
  addGameDirectory: () => unavailable("add_game_directory"),
  removeGameDirectory: () => unavailable("remove_game_directory"),
  openDataDirectory: () => unavailable("打开数据目录"),
  openLauncherLogs: () => unavailable("打开启动器日志目录"),
};

const CommandsContext = createContext<SettingsCommands>(SETTINGS_COMMANDS);

/** 测试注入替身用。 */
export const SettingsCommandsProvider = CommandsContext.Provider;

export function useSettingsCommands(): SettingsCommands {
  return useContext(CommandsContext);
}
