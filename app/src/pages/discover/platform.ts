// 发现页要用的宿主能力：系统选择文件夹对话框（认领手动下载的文件时选文件所在的文件夹）。
// 页面不能直接调用 Tauri 插件，真实实现在 shell/platform，由 App 装配时注入；没有注入时以明确的错误拒绝，
// 经外层统一提示出来。

import { createContext, useContext } from "react";

/** 系统选择文件夹对话框，从 defaultPath 打开，title 是对话框标题；用户取消为 null。 */
export type PickFolder = (defaultPath: string, title: string) => Promise<string | null>;

const UNAVAILABLE: PickFolder = () => Promise.reject(new Error("「选择文件夹」的宿主实现没有注入：发现页要放在 PickFolderProvider 之内"));

const PickFolderContext = createContext<PickFolder>(UNAVAILABLE);

/** 应用装配时注入真实实现，测试注入替身。 */
export const PickFolderProvider = PickFolderContext.Provider;

export function usePickFolder(): PickFolder {
  return useContext(PickFolderContext);
}
