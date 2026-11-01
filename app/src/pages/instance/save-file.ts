// 导出存档要用、页面又不能直接调用的宿主能力：系统保存文件对话框。页面不能引入 Tauri 插件，真实实现在 shell/platform，
// 由应用装配时注入；没有注入时以明确的错误拒绝，经外层统一提示出来。

import { createContext, useContext } from "react";

export interface SaveFileOptions {
  title: string;
  /** 默认文件名（可以不带文件夹）。 */
  defaultPath: string;
  /** 保存类型下拉的名称与不带点的扩展名。 */
  filter: { name: string; extensions: readonly string[] };
}

/** 系统保存文件对话框；选定返回完整路径，用户取消为 null。 */
export type PickSaveFile = (options: SaveFileOptions) => Promise<string | null>;

export const PICK_SAVE_FILE: PickSaveFile = () => Promise.reject(new Error("「保存文件」的宿主实现没有注入：实例页要放在 PickSaveFileProvider 之内"));

const SaveFileContext = createContext<PickSaveFile>(PICK_SAVE_FILE);

/** 应用装配时注入真实实现，测试注入替身。 */
export const PickSaveFileProvider = SaveFileContext.Provider;

export function usePickSaveFile(): PickSaveFile {
  return useContext(SaveFileContext);
}
