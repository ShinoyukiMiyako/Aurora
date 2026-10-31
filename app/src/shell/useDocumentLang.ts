// 把界面文案实际所用的语言写到 <html lang>：浏览器按它选断行与连字规则，读屏软件按它选发音。
// 写的是「文案实际是什么语言」而不是「设置里选了什么」：某种语言还没有译文时界面仍是中文，
// 这时写成那种语言会让读屏用错语音去念中文。配置读到之前（以及读失败时）不动它，保持页面自带的 zh-CN。

import { useLayoutEffect } from "react";
import type { UiLanguage } from "../ipc/config";
import { useLauncherSelector } from "../state/launcher";
import type { LauncherState } from "../state/store";

/** 已有译文的界面语言。English 还在预览、没有译文；某种语言的译文落地后加进来，<html lang> 随之跟设置走。 */
const TRANSLATED: ReadonlySet<UiLanguage> = new Set<UiLanguage>(["zh-CN"]);

/** 没有译文时界面文案落回的语言，与 index.html 自带的 lang 一致。 */
const SOURCE_TEXT_LANG: UiLanguage = "zh-CN";

/** 设置为 language 时界面文案实际所用的语言。 */
export function textLanguage(language: UiLanguage): UiLanguage {
  return TRANSLATED.has(language) ? language : SOURCE_TEXT_LANG;
}

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
    if (language !== null) applyDocumentLang(textLanguage(language));
  }, [language]);
}
