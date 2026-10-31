// 外壳布局给自己的视觉件（侧栏、命令面板）的两样能力：内容区滚回顶部、把焦点交给内容区。
// 只在外壳内部使用，不导出给页面；页面要的导航与外壳能力走 useNav / useShell。

import { createContext, createElement, useContext, type ReactNode } from "react";

export interface ChromeApi {
  /** 再点一次当前所在的侧栏条目：内容区滚回顶部（减少动画时直接跳）。 */
  scrollContentToTop(): void;
  /** 从命令面板导航之后，焦点落到内容区容器上，读屏从新页面开头读起。 */
  focusContent(): void;
}

const ChromeContext = createContext<ChromeApi | null>(null);

export function ChromeProvider({ value, children }: { value: ChromeApi; children: ReactNode }) {
  return createElement(ChromeContext.Provider, { value }, children);
}

export function useChrome(): ChromeApi {
  const api = useContext(ChromeContext);
  if (api === null) throw new Error("侧栏与命令面板必须放在外壳布局之内");
  return api;
}
