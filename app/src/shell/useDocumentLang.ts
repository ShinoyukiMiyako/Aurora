// 把界面语言写到 <html lang>：浏览器按它选断行与连字规则，读屏软件按它选发音。
// 配置读到之前（以及读失败时）不动它，保持页面自带的 zh-CN；读到之后随设置切换立即改写，不用重启。

import { useLayoutEffect } from "react";
import type { UiLanguage } from "../ipc/config";
import { useLauncherSelector } from "../state/launcher";
import type { LauncherState } from "../state/store";

export function applyDocumentLang(language: UiLanguage, root: HTMLElement = document.documentElement): void {
  root.lang = language;
}

/** 配置还没读到时为 null：这时没有可写的语言，不是缺省成某个语言。 */
const selectLanguage = (state: LauncherState): UiLanguage | null => (state.settings === null ? null : state.settings.language);

/** 只订阅语言这一项：外壳根挂着它，下载进度与游戏日志不能让外壳跟着重渲染。 */
export function useDocumentLang(): void {
  const language = useLauncherSelector(selectLanguage);
  // 布局阶段写入：读到配置后的第一帧就按新语言排版，不先按旧语言画一帧
  useLayoutEffect(() => {
    if (language !== null) applyDocumentLang(language);
  }, [language]);
}
