// 组件里的外部链接（资源介绍、更新说明里的网址）怎样打开：由外壳在应用根注入。
// 外壳给的打开方式经统一错误处理调用打开外部网址的动作，打开失败会弹通知；组件库不接触 IPC 与应用状态。

import { createContext, useCallback, useContext, type ReactNode } from "react";

/** 打开一个外部网址。失败的提示由注入方负责，组件只管调用。 */
export type ExternalLinkOpener = (url: string) => void;

const ExternalLinkContext = createContext<ExternalLinkOpener | null>(null);

export function ExternalLinkProvider({ open, children }: { open: ExternalLinkOpener; children: ReactNode }) {
  return <ExternalLinkContext.Provider value={open}>{children}</ExternalLinkContext.Provider>;
}

/** 取应用根注入的打开方式。没有注入是装配错误：真去打开时直接抛，不退回让 WebView 自己处理链接。 */
export function useExternalLinkOpener(): ExternalLinkOpener {
  const open = useContext(ExternalLinkContext);
  return useCallback(
    (url: string) => {
      if (open === null) throw new Error("外部链接需要在 ExternalLinkProvider 内打开：应用根缺少打开外部网址的方式");
      open(url);
    },
    [open],
  );
}
