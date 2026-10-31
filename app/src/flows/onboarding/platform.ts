// 向导要用的两样宿主能力：浏览器联网状态（断网时预先置灰微软与外置登录），
// 与系统选择文件夹对话框。后者要由状态层提供调用入口（流程不能直接调用 Tauri 插件），接入之前以明确的错误拒绝，
// 经外层统一提示出来；游戏目录框本身可以直接输入路径，不依赖它。

import { createContext, useContext, useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

const snapshot = () => navigator.onLine;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 系统选择文件夹对话框；用户取消为 null。 */
export type PickDirectory = (defaultPath: string) => Promise<string | null>;

export const PICK_DIRECTORY: PickDirectory = () => Promise.reject(new Error("状态层还没有提供「选择文件夹」的调用入口"));

const PickerContext = createContext<PickDirectory>(PICK_DIRECTORY);

/** 测试注入替身用。 */
export const PickDirectoryProvider = PickerContext.Provider;

export function usePickDirectory(): PickDirectory {
  return useContext(PickerContext);
}
