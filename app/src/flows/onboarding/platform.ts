// 向导要用的宿主能力：系统选择文件夹对话框。流程不能直接调用 Tauri 插件，真实实现在 shell/platform，由应用装配时注入；
// 没有注入时以明确的错误拒绝，经外层统一提示出来；游戏目录框本身可以直接输入路径，不依赖它。

import { createContext, useContext } from "react";

/** 系统选择文件夹对话框；用户取消为 null。 */
export type PickDirectory = (defaultPath: string) => Promise<string | null>;

export const PICK_DIRECTORY: PickDirectory = () => Promise.reject(new Error("「选择文件夹」的宿主实现没有注入：向导要放在 PickDirectoryProvider 之内"));

const PickerContext = createContext<PickDirectory>(PICK_DIRECTORY);

/** 应用装配时注入真实实现，测试注入替身。 */
export const PickDirectoryProvider = PickerContext.Provider;

export function usePickDirectory(): PickDirectory {
  return useContext(PickerContext);
}
